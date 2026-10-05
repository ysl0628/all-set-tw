import type { Env } from "../../platform/env";
import type { SyncTrigger } from "../../db";
import type { SyncOutcome } from "../../features/sync/types";
import { requireConnectorSettings } from "../../features/sync/config";
import { decryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { parsePublicConnectorConfig } from "../../features/sync/connector-state";
import { NeedsUserActionError } from "../../features/sync/errors";
import {
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../../features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "../../features/sync/record-mapper";
import { linkCanonicalBankAccountsStatement } from "../../features/sync/connector-repository";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";
import {
  collectDbsPayloads,
  DbsApiError,
  type DbsLogin,
  type DbsSession,
} from "./api";
import { loginDbsWithFetch } from "./login";
import {
  DbsProtocolError,
  parseDbsConfig,
  parseDbsPayloads,
  type DbsData,
} from "./protocol";

/**
 * 每次同步都重新以帳密登入，讀完資料後登出；登入只嘗試一次，
 * 不保存 token，也不觸發簡訊 OTP。
 */
export async function syncDbs(
  env: Env,
  trigger: SyncTrigger,
  login: DbsLogin = loginDbsWithFetch,
): Promise<SyncOutcome> {
  const connectorId = "dbs";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseDbsConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });
  if (!config.account || !config.password) {
    throw new NeedsUserActionError("請先儲存星展網銀的使用者代號與密碼。");
  }

  console.log(`[sync] ${connectorId}/${scope}: starting trigger=${trigger}`);

  let data: DbsData;
  let session: DbsSession | undefined;
  try {
    session = await login({
      account: config.account,
      password: config.password,
    });
    const now = new Date();
    data = parseDbsPayloads(await collectDbsPayloads(session, now), now);
  } catch (error) {
    throw dbsSyncError(error);
  } finally {
    if (session) {
      try {
        await session.logout();
      } catch {
        console.warn("[sync] dbs: logout unconfirmed");
      }
    }
  }

  const { bankAccounts, bankBalanceSnapshots, bankTransactions } = data;
  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length}`,
  );

  const now = new Date().toISOString();
  const records: SyncWriteRecord[] = [
    ...bankAccounts.map((account) =>
      bankAccountRecord(connectorId, account, now),
    ),
    ...bankBalanceSnapshots.map((snapshot) =>
      bankBalanceSnapshotRecord(connectorId, snapshot, now),
    ),
    ...bankTransactions.map((transaction) =>
      bankTransactionRecord(connectorId, transaction, now),
    ),
  ];

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements:
      bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : [],
    finalizeStatements: [],
  });

  if (bankBalanceSnapshots.length > 0) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }

  return {
    success: true,
    connectorId,
    scope,
    records:
      bankAccounts.length +
      bankBalanceSnapshots.length +
      bankTransactions.length,
    newRecords,
    cursorUpdated: false,
  };
}

/** 帳密、鎖定與重複登入需要使用者處理；其餘為連線或格式問題。 */
function dbsSyncError(error: unknown): unknown {
  if (error instanceof DbsProtocolError) {
    return new DbsApiError("protocol", error.operation);
  }
  if (!(error instanceof DbsApiError)) return error;
  switch (error.kind) {
    case "credentials":
      return new NeedsUserActionError("星展登入失敗，請確認使用者代號與密碼。");
    case "locked":
      return new NeedsUserActionError(
        "星展網銀帳號已鎖定或暫停使用，請至星展網銀處理後再同步。",
      );
    case "duplicate_session":
      return new NeedsUserActionError(
        "星展網銀已在其他裝置登入，請先登出後再同步。",
      );
    default:
      return error;
  }
}
