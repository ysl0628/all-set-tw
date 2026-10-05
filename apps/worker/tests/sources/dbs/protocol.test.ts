import { describe, expect, it } from "vitest";
import {
  DbsProtocolError,
  dbsNextCursor,
  dbsTransactionTargets,
  parseDbsPayloads,
} from "../../../src/sources/dbs/protocol";

// 結構取自去識別化的網銀回應；帳號、代號、金額與日期皆為合成值。
const now = new Date("2026-10-05T04:00:00.000Z");

function casa(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "******11111",
    globalAccountId: "GA-TWD",
    accountStatus: "A",
    schemeName: "臺幣數位存款",
    accountOpenedDate: { value: "2026-02-09", format: "yyyy-MM-dd" },
    availableBalance: { currency: "TWD", balance: "1,200", displayBalance: 0 },
    ledgerBalance: { currency: "TWD", balance: "1,250", displayBalance: 0 },
    multiCurrencyAccountFlag: false,
    displayAccountNumber: "12345671234",
    ...overrides,
  };
}

function tx(overrides: Record<string, unknown> = {}) {
  return {
    amount: { currency: "TWD", balance: "100", displayBalance: 0 },
    description: { textValue: "跨行轉帳", languageCode: "zh" },
    side: "D",
    remarks: null,
    postedDate: {
      value: "2026-09-21T10:05:47+0800",
      format: "yyyy-MM-dd'T'HH:mm:ssZ",
    },
    transactionDate: {
      value: "2026-09-21T00:00:00+0800",
      format: "yyyy-MM-dd'T'HH:mm:ssZ",
    },
    transactionReferenceNumber: "  R0001",
    runningBalance: { currency: "TWD", balance: "900", displayBalance: 0 },
    ...overrides,
  };
}

function page(transactions: unknown[], nextCursor: unknown = null) {
  return {
    pageInfo: { fetchedRecords: transactions.length, nextCursor },
    transactions,
  };
}

const assets = {
  casa: {
    accounts: [
      casa(),
      casa({
        globalAccountId: "GA-USD",
        schemeName: "外幣數位存款",
        availableBalance: { currency: "USD", balance: "10.5" },
        ledgerBalance: { currency: "USD", balance: "10.5" },
        displayAccountNumber: "12345672222",
      }),
      // 外幣總戶：沒有幣別與餘額，實際餘額在各幣別子帳戶。
      casa({
        globalAccountId: "GA-MASTER",
        schemeName: "外幣數位存款",
        availableBalance: { balance: "0" },
        ledgerBalance: { domesticCurrencyBalance: "0" },
        multiCurrencyAccountFlag: true,
        displayAccountNumber: "12345673333",
      }),
    ],
    status: "SUCCESS",
  },
  fixedDeposit: { accounts: [], status: "SUCCESS" },
};

describe("星展解析", () => {
  it("活存以顯示帳號識別、排除外幣總戶，名稱不含戶名", () => {
    const result = parseDbsPayloads({ assets, transactions: [] }, now);
    expect(result.bankAccounts).toEqual([
      expect.objectContaining({
        sourceId: expect.stringMatching(/^bank:dbs:1234:[0-9a-f]{8}:TWD$/),
        accountName: "臺幣數位存款（末四碼 1234）",
        currency: "TWD",
        openedDate: "2026-02-09",
      }),
      expect.objectContaining({
        sourceId: expect.stringMatching(/^bank:dbs:2222:[0-9a-f]{8}:USD$/),
        currency: "USD",
      }),
    ]);
    expect(
      result.bankBalanceSnapshots.map(({ balance, availableBalance }) => ({
        balance,
        availableBalance,
      })),
    ).toEqual([
      { balance: 1250, availableBalance: 1200 },
      { balance: 10.5, availableBalance: 10.5 },
    ]);
    expect(dbsTransactionTargets(assets)).toEqual([
      { globalAccountId: "GA-TWD", currency: "TWD" },
      { globalAccountId: "GA-USD", currency: "USD" },
    ]);
  });

  it("globalAccountId 改變時帳戶 sourceId 不變", () => {
    const first = parseDbsPayloads({ assets, transactions: [] }, now);
    const rotated = parseDbsPayloads(
      {
        assets: {
          casa: {
            ...assets.casa,
            accounts: [casa({ globalAccountId: "GA-OTHER-SESSION" })],
          },
        },
        transactions: [],
      },
      now,
    );
    expect(rotated.bankAccounts[0]?.sourceId).toBe(
      first.bankAccounts[0]?.sourceId,
    );
  });

  it("交易正負號依 side，金額取字串 balance 而非恆為 0 的 displayBalance", () => {
    const result = parseDbsPayloads(
      {
        assets,
        transactions: [
          {
            globalAccountId: "GA-TWD",
            pages: [
              page([
                tx({
                  side: "D",
                  amount: {
                    currency: "TWD",
                    balance: "2,534",
                    displayBalance: 0,
                  },
                  description: { textValue: "代繳代發" },
                  remarks: "星展信用卡扣款",
                }),
                tx({
                  side: "C",
                  amount: {
                    currency: "TWD",
                    balance: "1000",
                    displayBalance: 0,
                  },
                  remarks: "0000000000005007",
                  transactionReferenceNumber: "R0002",
                }),
              ]),
            ],
          },
        ],
      },
      now,
    );
    expect(
      result.bankTransactions.map(({ amount, description, postedDate }) => ({
        amount,
        description,
        postedDate,
      })),
    ).toEqual([
      {
        amount: -2534,
        // 摘要與備註合併，才能命中「信用卡繳費」系統規則。
        description: "代繳代發 星展信用卡扣款",
        postedDate: "2026-09-21",
      },
      // 備註中的完整帳號只保留末四碼。
      {
        amount: 1000,
        description: "跨行轉帳 ****5007",
        postedDate: "2026-09-21",
      },
    ]);
  });

  it("回溯以 transactionDate 判斷，跨月份重複的交易只入帳一次", () => {
    const interest = tx({
      side: "C",
      amount: { currency: "TWD", balance: "1" },
      description: { textValue: "活存息" },
      postedDate: { value: "2026-09-01T00:38:48+0800" },
      transactionDate: { value: "2026-08-31T00:00:00+0800" },
      transactionReferenceNumber: "R0003",
    });
    const result = parseDbsPayloads(
      {
        assets,
        transactions: [
          {
            globalAccountId: "GA-TWD",
            pages: [
              page([interest]),
              page([interest]),
              page([
                tx({
                  transactionDate: { value: "2026-07-31T00:00:00+0800" },
                  transactionReferenceNumber: "R0004",
                }),
              ]),
            ],
          },
        ],
      },
      now,
    );
    expect(result.bankTransactions).toEqual([
      expect.objectContaining({
        amount: 1,
        authorizedAt: "2026-08-31",
        postedDate: "2026-09-01",
      }),
    ]);
  });

  it("信用卡多張卡合併為單一卡戶應繳，負債為負值", () => {
    const result = parseDbsPayloads(
      {
        assets,
        transactions: [],
        liabilities: {
          creditCard: {
            cards: [{ cardNumber: "************0001" }, { cardNumber: "x" }],
            paymentDetails: {
              amount: 3000,
              dueDate: "2026-10-22",
              minimumAmount: 500,
              alreadyPaid: 1000,
              currency: "TWD",
            },
            status: "SUCCESS",
          },
          loan: null,
        },
      },
      now,
    );
    const cards = result.bankAccounts.filter((a) => a.accountType === "credit");
    expect(cards).toEqual([
      expect.objectContaining({ sourceId: "credit:dbs:main" }),
    ]);
    expect(
      result.bankBalanceSnapshots.find(
        (s) => s.accountId === "credit:dbs:main",
      ),
    ).toEqual(
      expect.objectContaining({
        balance: -2000,
        statementBalance: 3000,
        paymentDueDate: "2026-10-22",
        noPaymentNeeded: false,
      }),
    );
  });

  it("格式不符時拒絕解析，不寫入部分資料", () => {
    expect(() =>
      parseDbsPayloads(
        {
          assets,
          transactions: [
            { globalAccountId: "GA-TWD", pages: [page([tx({ side: "X" })])] },
          ],
        },
        now,
      ),
    ).toThrow(DbsProtocolError);
    expect(() =>
      parseDbsPayloads(
        {
          assets,
          transactions: [{ globalAccountId: "GA-UNKNOWN", pages: [] }],
        },
        now,
      ),
    ).toThrow(DbsProtocolError);
  });

  it("nextCursor 為 null 時停止分頁", () => {
    expect(dbsNextCursor(page([], null))).toBeNull();
    expect(dbsNextCursor(page([], ""))).toBeNull();
    expect(dbsNextCursor(page([], 20))).toBe(20);
  });
});
