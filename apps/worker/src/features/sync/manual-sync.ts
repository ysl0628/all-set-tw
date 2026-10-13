import type { Env } from "../../platform/env";
import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { type SyncScope, type SyncOutcome, SYNC_SCOPE_ALL } from "./types";
import { canonicalSyncLockRowId, SYNC_LOCK_LEASE_MS } from "./lock";
import { createSyncExecution, type SyncEnv } from "./execution";
import {
  acquireSyncJobLock,
  markManualSyncSuccess,
  type SyncStatus,
  markManualSyncFailure,
  releaseSyncJobLock,
  renewSyncJobLock,
} from "../../db";
import {
  SyncAlreadyRunningError,
  isUserActionError,
  safeErrorMessage,
} from "./errors";
import {
  findLatestRecoverableScheduledBatchId,
  recoverLatestScheduledSyncSource,
} from "./reports/repository";
import { beginActivityRun } from "./reports/activity-detail-repository";

/**
 * 背景手動同步在排入 Queue 時即取得鎖；租約涵蓋等待前一個 Queue 工作（最多 10 分鐘）
 * 加上本次執行，consumer 開始時再續租為一般租約。
 */
export const QUEUED_MANUAL_SYNC_LEASE_MS = 20 * 60 * 1000;

export async function withManualSyncLock(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  task: (env: SyncEnv) => Promise<SyncOutcome>,
) {
  const runId = crypto.randomUUID();
  await acquireManualSyncLock(
    env,
    connectorId,
    scope,
    runId,
    SYNC_LOCK_LEASE_MS,
  );
  return runWithManualSyncLock(env, connectorId, scope, runId, task);
}

/**
 * 取得鎖後排入背景手動同步，HTTP 回應不等待同步完成；瀏覽器斷線不會中止同步。
 * Queue message 只帶 runId，不攜帶 OTP 或任何憑證。
 */
export async function enqueueManualSync(env: Env, connectorId: ConnectorId) {
  const runId = crypto.randomUUID();
  const scope = SYNC_SCOPE_ALL;
  await acquireManualSyncLock(
    env,
    connectorId,
    scope,
    runId,
    QUEUED_MANUAL_SYNC_LEASE_MS,
  );
  try {
    await env.SYNC_QUEUE.send({ type: "run-manual-sync", connectorId, runId });
  } catch (error) {
    await abandonQueuedManualSync(
      env,
      connectorId,
      runId,
      "無法排入背景同步，請重新同步。",
    );
    throw error;
  }
  return runId;
}

/** 未執行就結束已排入的手動同步：記錄失敗並釋放仍屬於此 runId 的鎖。 */
export async function abandonQueuedManualSync(
  env: Env,
  connectorId: ConnectorId,
  runId: string,
  errorMessage: string,
) {
  try {
    await markManualSyncFailure(
      env.DB,
      connectorId,
      SYNC_SCOPE_ALL,
      { status: "failed", errorMessage },
      runId,
    );
  } finally {
    await releaseSyncJobLock(
      env.DB,
      canonicalSyncLockRowId(connectorId),
      runId,
    );
  }
}

/**
 * Queue consumer 執行已排入的手動同步。鎖已不屬於此 runId（逾時被清除或重複遞送）時不執行。
 * 結果由共用流程寫入 sync job；呼叫端不得重試，避免重複登入銀行或重寄 OTP。
 */
export async function runQueuedManualSync(
  env: Env,
  connectorId: ConnectorId,
  runId: string,
  task: (env: SyncEnv) => Promise<SyncOutcome>,
) {
  const owned = await renewSyncJobLock(env.DB, {
    lockRowId: canonicalSyncLockRowId(connectorId),
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });
  if (!owned) return false;
  await runWithManualSyncLock(env, connectorId, SYNC_SCOPE_ALL, runId, task);
  return true;
}

async function acquireManualSyncLock(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  runId: string,
  leaseMs: number,
) {
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId: canonicalSyncLockRowId(connectorId),
    scope,
    trigger: "manual",
    runId,
    leaseMs,
  });
  if (!locked) {
    throw new SyncAlreadyRunningError(connectorId);
  }
}

async function runWithManualSyncLock(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  runId: string,
  task: (env: SyncEnv) => Promise<SyncOutcome>,
) {
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const execution = createSyncExecution(env, { lockRowId, runId });
  let recoveryBatchId: string | null = null;
  try {
    return await execution.run(async (syncEnv) => {
      recoveryBatchId =
        connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL
          ? await findLatestRecoverableScheduledBatchId(env.DB, connectorId)
          : null;
      await beginActivityRun(syncEnv.DB, runId, recoveryBatchId, connectorId);
      const outcome = await task(syncEnv);
      await markManualSyncSuccess(syncEnv.DB, connectorId, scope, runId);
      if (connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL) {
        await recoverLatestScheduledSyncSource(syncEnv.DB, {
          connectorId,
          newRecords: outcome.newRecords,
          batchId: recoveryBatchId,
          runId,
        }).catch((error) => {
          // A report repair must never turn an otherwise successful manual sync
          // into a failed sync response.
          console.error(
            "[sync] failed to recover latest scheduled report",
            error,
          );
        });
      }
      return outcome;
    });
  } catch (error) {
    const status: SyncStatus = isUserActionError(error)
      ? "needs_user_action"
      : "failed";
    await markManualSyncFailure(
      env.DB,
      connectorId,
      scope,
      {
        status,
        errorMessage: safeErrorMessage(error),
      },
      runId,
    );
    throw error;
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}
