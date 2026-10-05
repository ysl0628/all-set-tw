import { describe, expect, it } from "vitest";
import {
  collectDbsPayloads,
  dbsMonthWindows,
  DbsApiError,
  type DbsRequest,
} from "../../../src/sources/dbs/api";

// 帳戶代號與金額為合成值。
const now = new Date("2026-10-05T04:00:00.000Z");

const assets = {
  casa: {
    accounts: [
      {
        globalAccountId: "GA-TWD",
        accountStatus: "A",
        schemeName: "臺幣數位存款",
        multiCurrencyAccountFlag: false,
        displayAccountNumber: "12345671234",
        ledgerBalance: { currency: "TWD", balance: "100" },
      },
    ],
    status: "SUCCESS",
  },
};

function fakeSession(nextCursors: Array<string | number | null>) {
  const requests: DbsRequest[] = [];
  let txCalls = 0;
  return {
    requests,
    session: {
      async request(request: DbsRequest) {
        requests.push(request);
        if (request.actionId === "DASHBOARD-ASSET") return assets;
        if (request.actionId === "DASHBOARD-LIABILITY") {
          return { creditCard: null, loan: null };
        }
        const nextCursor = nextCursors[txCalls] ?? null;
        txCalls += 1;
        return { pageInfo: { nextCursor }, transactions: [] };
      },
      async logout() {},
    },
  };
}

describe("星展資料讀取", () => {
  it("明細依臺灣時區逐月查詢，當月到現在並帶當月 header", () => {
    expect(dbsMonthWindows(now)).toEqual([
      {
        from: "2026-10-01T00:00:00+0800",
        to: "2026-10-05T12:00:00+0800",
        isCurrentMonth: true,
      },
      {
        from: "2026-09-01T00:00:00+0800",
        to: "2026-09-30T23:59:59+0800",
        isCurrentMonth: false,
      },
      {
        from: "2026-08-01T00:00:00+0800",
        to: "2026-08-31T23:59:59+0800",
        isCurrentMonth: false,
      },
    ]);
  });

  it("依 nextCursor 續查分頁，直到 null", async () => {
    const { session, requests } = fakeSession([20, null, null, null]);
    const payloads = await collectDbsPayloads(session, now);
    const history = requests.filter(
      (request) => request.actionId === "DEPOSIT-TXN-HISTORY",
    );
    expect(history).toHaveLength(4);
    expect(
      history.map(
        (request) => (request.body as { cursorId: unknown }).cursorId,
      ),
    ).toEqual([0, 20, 0, 0]);
    expect(history[0]?.headers).toEqual({ isCurrentMonthHeader: "true" });
    expect(history[2]?.headers).toBeUndefined();
    expect(payloads.transactions).toEqual([
      { globalAccountId: "GA-TWD", pages: expect.any(Array) },
    ]);
    expect(payloads.transactions[0]?.pages).toHaveLength(4);
  });

  it("分頁數超過上限時拒絕，不回傳部分資料", async () => {
    const { session } = fakeSession(Array.from({ length: 30 }, () => 1));
    await expect(collectDbsPayloads(session, now)).rejects.toBeInstanceOf(
      DbsApiError,
    );
  });
});
