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
} from "../../features/sync/connector-repository";
import { recognizeAlphanumericCaptcha } from "../../features/ocr/service";
import {
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../../features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
  creditCardBillRecord,
} from "../../features/sync/record-mapper";
import {
  HSBC_CAPTCHA_TTL_MS,
  HsbcApiClient,
  HsbcApiError,
  collectHsbcCardPayloads,
} from "./api";
import {
  closeHsbcBrowser,
  launchHsbcBrowser,
  reconnectHsbcBrowser,
} from "./browser";
import { hsbcConfigSchema, parseHsbcCards } from "./protocol";

/** 匯豐信用卡網頁登入頁的英數圖形驗證碼長度。 */
export const HSBC_CAPTCHA_LENGTH = 5;
const AUTO_CAPTCHA_ATTEMPTS = 3;
const CONNECTOR_ID = "hsbc";

export type HsbcSyncOverrides = { captcha?: string };

function hsbcCleanConfig(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.captchaKey;
  delete cleaned.captchaCookies;
  delete cleaned.browserSessionId;
  delete cleaned.captchaExpiresAt;
  return cleaned;
}

export async function prepareHsbcCaptchaSession(env: Env) {
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
    const config = hsbcConfigSchema.parse(stored);
    if (!config.account || !config.password) {
      throw new NeedsUserActionError("請先儲存匯豐信用卡網路服務的帳密。");
    }
    const cleared = await encryptJson(
      hsbcCleanConfig(stored),
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
    const context = await launchHsbcBrowser(env.BROWSER);
    let preserved = false;
    try {
      const challenge = await new HsbcApiClient({
        fetcher: context.fetcher,
      }).prepareCaptcha(config.account);
      await compareAndSetConnectorSecret(
        env.DB,
        CONNECTOR_ID,
        { encrypted_config: cleared, updated_at: clearedAt },
        await encryptJson(
          {
            ...hsbcCleanConfig(stored),
            captchaKey: challenge.key,
            browserSessionId: context.browser.sessionId(),
            captchaExpiresAt: challenge.expiresAt,
          },
          configEncryptionKey(env),
        ),
        new Date().toISOString(),
      );
      await context.browser.disconnect();
      preserved = true;
      return {
        captchaImage: challenge.dataUri,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        captchaLength: HSBC_CAPTCHA_LENGTH,
        captchaKind: "alphanumeric" as const,
      };
    } catch (error) {
      throw userFacingError(error);
    } finally {
      if (!preserved) await closeHsbcBrowser(context.browser);
    }
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncHsbc(
  env: Env,
  _trigger: SyncTrigger,
  overrides: HsbcSyncOverrides = {},
): Promise<SyncOutcome> {
  const settings = await requireConnectorSettings(env.DB, CONNECTOR_ID);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = hsbcConfigSchema.parse(stored);
  if (!config.account || !config.password) {
    throw new NeedsUserActionError("請先儲存匯豐信用卡網路服務的帳密。");
  }
  // 先消耗已保存的驗證碼 challenge，失敗時也不能重複使用。
  const cleaned = await encryptJson(
    hsbcCleanConfig(stored),
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

  const context = overrides.captcha
    ? config.browserSessionId
      ? await reconnectHsbcBrowser(env.BROWSER, config.browserSessionId)
      : undefined
    : await launchHsbcBrowser(env.BROWSER);
  if (!context) {
    throw new NeedsUserActionError(
      "匯豐驗證碼工作階段已逾時，請重新取得驗證碼。",
    );
  }
  const client = new HsbcApiClient({ fetcher: context.fetcher });
  let payloads: Awaited<ReturnType<typeof collectHsbcCardPayloads>>;
  try {
    if (overrides.captcha) {
      if (
        !config.captchaKey ||
        !config.captchaExpiresAt ||
        Date.now() >= config.captchaExpiresAt ||
        config.captchaExpiresAt > Date.now() + HSBC_CAPTCHA_TTL_MS
      ) {
        throw new NeedsUserActionError("匯豐驗證碼已過期，請重新取得驗證碼。");
      }
      await client.login({
        account: config.account,
        password: config.password,
        captchaKey: config.captchaKey,
        captcha: overrides.captcha,
      });
    } else {
      await loginWithRecognizedCaptcha(env, client, {
        account: config.account,
        password: config.password,
      });
    }
    payloads = await collectHsbcCardPayloads(client);
  } catch (error) {
    throw userFacingError(error, Boolean(overrides.captcha));
  } finally {
    try {
      await client.logout();
    } catch {
      console.warn("[sync] hsbc: logout unconfirmed");
    }
    await closeHsbcBrowser(context.browser);
  }

  const result = parseHsbcCards(payloads);
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
    ...result.creditCardBills.map((bill) =>
      creditCardBillRecord(CONNECTOR_ID, bill, now),
    ),
  ];
  const cursor = JSON.stringify({ syncedAt: now });
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    beforePromoteStatements: [
      connectorSettingsGuardStatement(env.DB, CONNECTOR_ID, cleaned, version),
    ],
    finalizeStatements: [
      connectorCursorStatement(env.DB, CONNECTOR_ID, cursor, now),
    ],
  });
  return {
    success: true,
    connectorId: CONNECTOR_ID,
    scope: SYNC_SCOPE_ALL,
    records: records.length,
    newRecords,
    cursorUpdated: true,
  };
}

/** 每次取新的驗證碼交給 Workers AI；只有驗證碼錯誤會重試，帳密錯誤立即停止。 */
async function loginWithRecognizedCaptcha(
  env: Env,
  client: HsbcApiClient,
  credentials: { account: string; password: string },
) {
  for (let attempt = 1; attempt <= AUTO_CAPTCHA_ATTEMPTS; attempt += 1) {
    const challenge = await client.prepareCaptcha(credentials.account);
    let answer: string;
    try {
      answer = (
        await recognizeAlphanumericCaptcha(
          env.AI,
          challenge.imageBytes,
          challenge.contentType,
          HSBC_CAPTCHA_LENGTH,
        )
      ).code;
    } catch {
      throw new ManualCaptchaRequiredError(
        "匯豐驗證碼無法自動辨識，請改用人工輸入。",
      );
    }
    try {
      await client.login({
        ...credentials,
        captchaKey: challenge.key,
        captcha: answer,
      });
      return;
    } catch (error) {
      if (
        error instanceof HsbcApiError &&
        error.kind === "captcha" &&
        attempt < AUTO_CAPTCHA_ATTEMPTS
      ) {
        continue;
      }
      if (error instanceof HsbcApiError && error.kind === "captcha") {
        throw new ManualCaptchaRequiredError(
          "匯豐驗證碼連續自動辨識失敗，請改用人工輸入。",
        );
      }
      throw error;
    }
  }
}

function userFacingError(error: unknown, manualCaptcha = false): unknown {
  if (!(error instanceof HsbcApiError)) return error;
  console.warn(
    JSON.stringify({
      event: "hsbc_api_error",
      kind: error.kind,
      ...(error.operation ? { operation: error.operation } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
      manualCaptcha,
    }),
  );
  switch (error.kind) {
    case "captcha":
      return manualCaptcha
        ? new NeedsUserActionError("匯豐驗證碼錯誤，請重新取得驗證碼。")
        : new ManualCaptchaRequiredError(
            "匯豐驗證碼無法自動辨識，請改用人工輸入。",
          );
    case "credentials":
      return new NeedsUserActionError(
        "匯豐登入失敗，請確認信用卡網路服務的使用者代號與密碼。",
      );
    case "otp_required":
      return new NeedsUserActionError(
        "匯豐要求額外的身分驗證，請先在官網登入一次完成驗證後再同步。",
      );
    case "session_expired":
      return new NeedsUserActionError("匯豐登入狀態已失效，請重新同步。");
    default:
      return error;
  }
}
