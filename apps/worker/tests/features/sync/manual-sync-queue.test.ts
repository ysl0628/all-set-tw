import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ScheduledSyncQueueMessage } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  acquireSyncJobLock: vi.fn(),
  renewSyncJobLock: vi.fn(),
  releaseSyncJobLock: vi.fn(),
  markManualSyncFailure: vi.fn(),
  markManualSyncSuccess: vi.fn(),
}));

vi.mock("../../../src/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...mocks,
}));

import {
  enqueueManualSync,
  QUEUED_MANUAL_SYNC_LEASE_MS,
  runQueuedManualSync,
} from "../../../src/features/sync/manual-sync";
import { SyncAlreadyRunningError } from "../../../src/features/sync/errors";

function env(send = vi.fn().mockResolvedValue(undefined)) {
  return {
    DB: {} as D1Database,
    SYNC_QUEUE: { send } as unknown as Queue<ScheduledSyncQueueMessage>,
  } as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireSyncJobLock.mockResolvedValue(true);
  mocks.releaseSyncJobLock.mockResolvedValue(undefined);
  mocks.markManualSyncFailure.mockResolvedValue(undefined);
});

describe("背景手動同步的同步鎖", () => {
  it("排入時以涵蓋 Queue 等待的租約取得鎖，訊息只帶 runId", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    const runId = await enqueueManualSync(env(send), "cathaybk");

    expect(mocks.acquireSyncJobLock).toHaveBeenCalledWith(expect.anything(), {
      lockRowId: "cathaybk:all",
      scope: "all",
      trigger: "manual",
      runId,
      leaseMs: QUEUED_MANUAL_SYNC_LEASE_MS,
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "run-manual-sync",
      connectorId: "cathaybk",
      runId,
    });
    expect(mocks.releaseSyncJobLock).not.toHaveBeenCalled();
  });

  it("已有同步執行中時不排入 Queue", async () => {
    const send = vi.fn();
    mocks.acquireSyncJobLock.mockResolvedValue(false);

    await expect(enqueueManualSync(env(send), "cathaybk")).rejects.toThrow(
      SyncAlreadyRunningError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("排入 Queue 失敗時記錄失敗並釋放鎖", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));

    await expect(enqueueManualSync(env(send), "cathaybk")).rejects.toThrow(
      "queue unavailable",
    );
    const runId = mocks.acquireSyncJobLock.mock.calls[0]![1].runId;
    expect(mocks.markManualSyncFailure).toHaveBeenCalledWith(
      expect.anything(),
      "cathaybk",
      "all",
      expect.objectContaining({ status: "failed" }),
      runId,
    );
    expect(mocks.releaseSyncJobLock).toHaveBeenCalledWith(
      expect.anything(),
      "cathaybk:all",
      runId,
    );
  });

  it("鎖已不屬於此 runId 時不執行同步", async () => {
    mocks.renewSyncJobLock.mockResolvedValue(false);
    const task = vi.fn();

    await expect(
      runQueuedManualSync(env(), "cathaybk", "stale-run", task),
    ).resolves.toBe(false);
    expect(task).not.toHaveBeenCalled();
    expect(mocks.markManualSyncSuccess).not.toHaveBeenCalled();
    expect(mocks.releaseSyncJobLock).not.toHaveBeenCalled();
  });
});
