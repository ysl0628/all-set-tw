import type { Env } from "../../platform/env";
import { canonicalSyncLockRowId } from "../../features/sync/lock";
import {
  acquireSyncJobLock,
  releaseSyncJobLock,
  type SyncTrigger,
} from "../../db";
import { SYNC_SCOPE_ALL, type SyncOutcome } from "../../features/sync/types";
import {
  ManualCaptchaRequiredError,
  NeedsUserActionError,
  SyncAlreadyRunningError,
} from "../../features/sync/errors";
import { requireConnectorSettings } from "../../features/sync/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import {
  compareAndSetConnectorSecret,
  connectorCursorStatement,
  connectorSettingsGuardStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import { recognizeNumericCaptcha } from "../../features/ocr/service";
import {
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../../features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "../../features/sync/record-mapper";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";
import {
  RICHART_CAPTCHA_LENGTH,
  RICHART_CAPTCHA_TTL_MS,
  RichartApiClient,
  RichartApiError,
  collectRichartPayloads,
  type RichartCredentials,
} from "./api";
import { parseRichartPayloads, richartConfigSchema } from "./protocol";
import { prepareRichartDepositWrite } from "./deposits";

const CONNECTOR_ID = "richart";
const AUTO_CAPTCHA_ATTEMPTS = 3;

export type RichartSyncOverrides = { captcha?: string };

function richartCleanConfig(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.captchaSessionId;
  delete cleaned.captchaCookies;
  delete cleaned.captchaExpiresAt;
  return cleaned;
}

function credentialsOf(
  config: ReturnType<typeof richartConfigSchema.parse>,
): RichartCredentials {
  if (!config.userId || !config.account || !config.password) {
    throw new NeedsUserActionError("請先儲存 Richart 網銀的身分證字號與帳密。");
  }
  return {
    identity: config.userId,
    userName: config.account,
    password: config.password,
  };
}

export async function prepareRichartCaptchaSession(env: Env) {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(CONNECTOR_ID);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: SYNC_SCOPE_ALL,
    trigger: "manual",
    runId,
    leaseMs: 180_000,
  });
  if (!locked) throw new SyncAlreadyRunningError(CONNECTOR_ID);
  try {
    const settings = await requireConnectorSettings(env.DB, CONNECTOR_ID);
    const stored = await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    );
    credentialsOf(richartConfigSchema.parse(stored));
    const cleared = await encryptJson(
      richartCleanConfig(stored),
      configEncryptionKey(env),
    );
    const clearedAt = new Date().toISOString();
    await compareAndSetConnectorSecret(
      env.DB,
      CONNECTOR_ID,
      settings,
      cleared,
      clearedAt,
    );
    const client = new RichartApiClient();
    let challenge: Awaited<ReturnType<RichartApiClient["prepareCaptcha"]>>;
    try {
      challenge = await client.prepareCaptcha();
    } catch (error) {
      throw userFacingError(error);
    }
    await compareAndSetConnectorSecret(
      env.DB,
      CONNECTOR_ID,
      { encrypted_config: cleared, updated_at: clearedAt },
      await encryptJson(
        {
          ...richartCleanConfig(stored),
          captchaSessionId: challenge.securityCodeSessionId,
          captchaCookies: client.exportCookies(),
          captchaExpiresAt: challenge.expiresAt,
        },
        configEncryptionKey(env),
      ),
      new Date().toISOString(),
    );
    return {
      captchaImage: challenge.dataUri,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      captchaLength: RICHART_CAPTCHA_LENGTH.max,
      captchaMinLength: RICHART_CAPTCHA_LENGTH.min,
      captchaKind: "numeric" as const,
    };
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncRichart(
  env: Env,
  _trigger: SyncTrigger,
  overrides: RichartSyncOverrides = {},
): Promise<SyncOutcome> {
  const settings = await requireConnectorSettings(env.DB, CONNECTOR_ID);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = richartConfigSchema.parse(stored);
  const credentials = credentialsOf(config);
  // 先消耗已保存的檢核碼 challenge，失敗時也不能重複使用。
  const cleaned = await encryptJson(
    richartCleanConfig(stored),
    configEncryptionKey(env),
  );
  const version = new Date().toISOString();
  await compareAndSetConnectorSecret(
    env.DB,
    CONNECTOR_ID,
    settings,
    cleaned,
    version,
  );

  let client: RichartApiClient;
  let loggedIn = false;
  let payloads: Awaited<ReturnType<typeof collectRichartPayloads>>;
  try {
    if (overrides.captcha) {
      if (
        !config.captchaSessionId ||
        !config.captchaCookies ||
        !config.captchaExpiresAt ||
        Date.now() >= config.captchaExpiresAt ||
        config.captchaExpiresAt > Date.now() + RICHART_CAPTCHA_TTL_MS
      ) {
        throw new NeedsUserActionError(
          "Richart 檢核碼已過期，請重新取得檢核碼。",
        );
      }
      client = new RichartApiClient({ cookies: config.captchaCookies });
      await client.login(credentials, {
        securityCodeSessionId: config.captchaSessionId,
        securityCode: overrides.captcha,
      });
    } else {
      client = await loginWithRecognizedCaptcha(env, credentials);
    }
    loggedIn = true;
    payloads = await collectRichartPayloads(client);
  } catch (error) {
    throw userFacingError(error, Boolean(overrides.captcha));
  } finally {
    if (loggedIn) {
      try {
        await client!.logout();
      } catch {
        console.warn("[sync] richart: logout unconfirmed");
      }
    }
  }

  let result: ReturnType<typeof parseRichartPayloads>;
  try {
    result = parseRichartPayloads(payloads);
  } catch (error) {
    throw userFacingError(error);
  }
  const now = new Date().toISOString();
  const records: SyncWriteRecord[] = [
    ...result.bankAccounts.map((account) =>
      bankAccountRecord(CONNECTOR_ID, account, now),
    ),
    ...result.bankBalanceSnapshots.map((snapshot) =>
      bankBalanceSnapshotRecord(CONNECTOR_ID, snapshot, now),
    ),
    ...result.bankTransactions.map((transaction) =>
      bankTransactionRecord(CONNECTOR_ID, transaction, now),
    ),
  ];
  const depositWrite = await prepareRichartDepositWrite(env.DB, result, now);
  records.push(...depositWrite.records);
  const cursor = JSON.stringify({ syncedAt: now });
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    beforePromoteStatements: [
      connectorSettingsGuardStatement(env.DB, CONNECTOR_ID, cleaned, version),
    ],
    afterPromoteStatements: [
      ...depositWrite.afterPromoteStatements,
      linkCanonicalBankAccountsStatement(env.DB),
    ],
    finalizeStatements: [
      connectorCursorStatement(env.DB, CONNECTOR_ID, cursor, now),
    ],
  });
  await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  return {
    success: true,
    connectorId: CONNECTOR_ID,
    scope: SYNC_SCOPE_ALL,
    records: records.length,
    newRecords,
    cursorUpdated: true,
  };
}

/**
 * 每次取新的檢核碼交給 Workers AI；銀行在任何登入錯誤後都要求重新取得檢核碼。
 * 只有檢核碼錯誤會重試，帳密錯誤立即停止。
 */
async function loginWithRecognizedCaptcha(
  env: Env,
  credentials: RichartCredentials,
): Promise<RichartApiClient> {
  for (let attempt = 1; attempt <= AUTO_CAPTCHA_ATTEMPTS; attempt += 1) {
    const client = new RichartApiClient();
    const challenge = await client.prepareCaptcha();
    let answer: string;
    try {
      answer = (
        await recognizeNumericCaptcha(
          env.AI,
          challenge.imageBytes,
          challenge.contentType,
          RICHART_CAPTCHA_LENGTH,
        )
      ).number;
    } catch {
      throw new ManualCaptchaRequiredError(
        "Richart 檢核碼無法自動辨識，請改用人工輸入。",
      );
    }
    try {
      await client.login(credentials, {
        securityCodeSessionId: challenge.securityCodeSessionId,
        securityCode: answer,
      });
      return client;
    } catch (error) {
      if (!(error instanceof RichartApiError) || error.kind !== "captcha") {
        throw error;
      }
      if (attempt === AUTO_CAPTCHA_ATTEMPTS) {
        throw new ManualCaptchaRequiredError(
          "Richart 檢核碼連續自動辨識失敗，請改用人工輸入。",
        );
      }
    }
  }
  throw new ManualCaptchaRequiredError(
    "Richart 檢核碼無法自動辨識，請改用人工輸入。",
  );
}

function userFacingError(error: unknown, manualCaptcha = false): unknown {
  if (!(error instanceof RichartApiError)) return error;
  console.warn(
    JSON.stringify({
      event: "richart_api_error",
      kind: error.kind,
      ...(error.operation ? { operation: error.operation } : {}),
      ...(error.bankCode ? { bankCode: error.bankCode } : {}),
      manualCaptcha,
    }),
  );
  switch (error.kind) {
    case "captcha":
      return manualCaptcha
        ? new NeedsUserActionError("Richart 檢核碼錯誤，請重新取得檢核碼。")
        : new ManualCaptchaRequiredError(
            "Richart 檢核碼無法自動辨識，請改用人工輸入。",
          );
    case "credentials":
      return new NeedsUserActionError(
        "Richart 登入失敗，請確認身分證字號、使用者代號與密碼。",
      );
    case "session_conflict":
      return new NeedsUserActionError(
        "Richart 網銀目前在其他地方登入中，請先登出後再同步。",
      );
    case "session_expired":
      return new NeedsUserActionError("Richart 登入狀態已失效，請重新同步。");
    case "account_unavailable":
      return new NeedsUserActionError(
        "Richart 帳戶目前無法使用網銀（尚未開戶、審核中或待補件）。",
      );
    default:
      return error;
  }
}
