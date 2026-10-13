import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ScheduledSyncQueueMessage } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  failEinvoiceSyncRun: vi.fn(),
  failTdccSyncRun: vi.fn(),
  isEinvoiceUserActionError: vi.fn(),
  processEinvoiceSyncChunk: vi.fn(),
  processTdccSyncChunk: vi.fn(),
  runSchedulerTick: vi.fn(),
  recoverStalledSyncRuns: vi.fn(),
  runQueuedManualSync: vi.fn(),
  abandonQueuedManualSync: vi.fn(),
  runConnectorSync: vi.fn(),
}));

vi.mock("../../../src/features/sync/manual-sync", () => ({
  runQueuedManualSync: mocks.runQueuedManualSync,
  abandonQueuedManualSync: mocks.abandonQueuedManualSync,
}));
vi.mock("../../../src/features/sync/registry", () => ({
  runConnectorSync: mocks.runConnectorSync,
}));

vi.mock("../../../src/features/sync/scheduling/scheduler", () => ({
  runSchedulerTick: mocks.runSchedulerTick,
}));
vi.mock("../../../src/features/sync/scheduling/recovery", () => ({
  recoverStalledSyncRuns: mocks.recoverStalledSyncRuns,
}));

vi.mock("../../../src/sources/einvoice/sync", () => ({
  failEinvoiceSyncRun: mocks.failEinvoiceSyncRun,
  isEinvoiceUserActionError: mocks.isEinvoiceUserActionError,
  processEinvoiceSyncChunk: mocks.processEinvoiceSyncChunk,
}));

vi.mock("../../../src/sources/tdcc/sync", () => ({
  failTdccSyncRun: mocks.failTdccSyncRun,
  processTdccSyncChunk: mocks.processTdccSyncChunk,
}));
import {
  consumeScheduledSyncQueue,
  DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS,
  enqueueScheduledSync,
} from "../../../src/features/sync/scheduling/queue";
import { CathayOtpSessionExpiredError } from "../../../src/sources/cathaybk/connector";

function queueMessage(body: ScheduledSyncQueueMessage) {
  return {
    id: "message-1",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<ScheduledSyncQueueMessage>;
}

function queueBatch(message: Message<ScheduledSyncQueueMessage>) {
  return {
    queue: "taiwan-fin-hub-sync",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<ScheduledSyncQueueMessage>;
}

function env(send = vi.fn().mockResolvedValue(undefined)) {
  return {
    DB: {} as D1Database,
    SYNC_QUEUE: { send } as unknown as Queue<ScheduledSyncQueueMessage>,
  } as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEinvoiceUserActionError.mockReturnValue(false);
  mocks.recoverStalledSyncRuns.mockResolvedValue(undefined);
  mocks.abandonQueuedManualSync.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled sync queue", () => {
  it("停滯恢復失敗仍會送出 scheduler kick", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mocks.recoverStalledSyncRuns.mockRejectedValueOnce(
      new Error("synthetic recovery failure"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await enqueueScheduledSync(env(send));
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "run-next-scheduled-sync",
    });
  });
  it("does not enqueue the scheduler kick in demo mode", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await enqueueScheduledSync({ ...env(send), DEMO_MODE: "true" } as Env);

    expect(send).not.toHaveBeenCalled();
  });

  it("parks durable run chunks without running them in demo mode", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const kick = queueMessage({ type: "run-next-scheduled-sync" });
    const tdcc = queueMessage({ type: "run-tdcc-chunk", runId: "tdcc-run-1" });
    const einvoice = queueMessage({
      type: "run-einvoice-chunk",
      runId: "einvoice-run-1",
    });
    const batch = {
      ...queueBatch(kick),
      messages: [kick, tdcc, einvoice],
    } as unknown as MessageBatch<ScheduledSyncQueueMessage>;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await consumeScheduledSyncQueue(batch, {
      ...env(send),
      DEMO_MODE: "true",
    } as Env);

    for (const message of [kick, tdcc, einvoice]) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      { type: "run-tdcc-chunk", runId: "tdcc-run-1" },
      { delaySeconds: DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS },
    );
    expect(send).toHaveBeenCalledWith(
      { type: "run-einvoice-chunk", runId: "einvoice-run-1" },
      { delaySeconds: DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS },
    );
    expect(mocks.runSchedulerTick).not.toHaveBeenCalled();
    expect(mocks.processTdccSyncChunk).not.toHaveBeenCalled();
    expect(mocks.processEinvoiceSyncChunk).not.toHaveBeenCalled();
  });

  it("背景手動同步以 runId 執行並 ack", async () => {
    mocks.runQueuedManualSync.mockImplementation(
      async (_env, _connectorId, _runId, task) => {
        await task({} as Env);
        return true;
      },
    );
    const message = queueMessage({
      type: "run-manual-sync",
      connectorId: "cathaybk",
      runId: "manual-run-1",
    });

    await consumeScheduledSyncQueue(queueBatch(message), env());

    expect(mocks.runQueuedManualSync).toHaveBeenCalledWith(
      expect.anything(),
      "cathaybk",
      "manual-run-1",
      expect.any(Function),
    );
    expect(mocks.runConnectorSync).toHaveBeenCalledWith(
      expect.anything(),
      "cathaybk",
      "manual",
      "all",
      {},
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("國泰 OTP 工作階段過期時只以全新登入重試一次", async () => {
    mocks.runQueuedManualSync.mockImplementation(
      async (_env, _connectorId, _runId, task) => {
        await task({} as Env);
        return true;
      },
    );
    mocks.runConnectorSync
      .mockRejectedValueOnce(new CathayOtpSessionExpiredError())
      .mockResolvedValueOnce({ newRecords: 0 });
    const message = queueMessage({
      type: "run-manual-sync",
      connectorId: "cathaybk",
      runId: "manual-run-1",
    });

    await consumeScheduledSyncQueue(queueBatch(message), env());

    expect(mocks.runConnectorSync).toHaveBeenCalledTimes(2);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("背景手動同步失敗或鎖已不屬於本次時仍 ack，不重試登入", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = queueMessage({
      type: "run-manual-sync",
      connectorId: "cathaybk",
      runId: "manual-run-1",
    });
    mocks.runQueuedManualSync.mockRejectedValueOnce(
      new Error("synthetic bank failure"),
    );
    await consumeScheduledSyncQueue(queueBatch(failed), env());

    const stale = queueMessage({
      type: "run-manual-sync",
      connectorId: "cathaybk",
      runId: "manual-run-2",
    });
    mocks.runQueuedManualSync.mockResolvedValueOnce(false);
    await consumeScheduledSyncQueue(queueBatch(stale), env());

    for (const message of [failed, stale]) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it("Demo 模式不執行背景手動同步並釋放排入時的鎖", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const message = queueMessage({
      type: "run-manual-sync",
      connectorId: "cathaybk",
      runId: "manual-run-1",
    });

    await consumeScheduledSyncQueue(queueBatch(message), {
      ...env(send),
      DEMO_MODE: "true",
    } as Env);

    expect(mocks.runQueuedManualSync).not.toHaveBeenCalled();
    expect(mocks.abandonQueuedManualSync).toHaveBeenCalledWith(
      expect.anything(),
      "cathaybk",
      "manual-run-1",
      expect.any(String),
    );
    expect(send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
