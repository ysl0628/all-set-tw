import { describe, expect, it } from "vitest";
import { RichartApiError } from "../../../src/sources/richart/api";
import {
  parseRichartPayloads,
  parseRichartTransactions,
} from "../../../src/sources/richart/protocol";

// 欄位名稱取自官方網銀 bundle 的 reducer 與模板；帳號與金額為合成值。
// 尚待以真實回應（去識別化）替換，見 docs/004-connector-development.md。
const now = new Date("2026-10-04T04:00:00.000Z");

function payloads(overrides: Record<string, unknown> = {}) {
  return {
    savingAccount: {
      account: "28881000012345",
      balance: "152,300",
      balanceAvailable: 150000,
    },
    transactionPages: [
      {
        transLogList: [
          { date: "20261003", amount: -120, title: "轉帳至 0123456789012" },
          { date: "20261001", amount: 50000, title: "薪資" },
        ],
      },
      {
        transLogList: [
          { date: "20261001", amount: 50000, title: "薪資" },
          { date: "20260915", amount: -85, title: "全家便利商店" },
          { date: "20260915", amount: -85, title: "全家便利商店" },
        ],
      },
      { transLogList: [{ date: "20260801", amount: 3, title: "利息" }] },
      { transLogList: [{ date: "20260720", amount: -10, title: "舊交易" }] },
    ],
    subAccounts: {
      subAccountOverview: { hasSA: true, totalAmount: "8,000" },
    },
    twdTimeDeposits: {
      depositList: [{ depositSeq: "1" }],
      ntSumAmount: 100000,
    },
    ...overrides,
  };
}

describe("Richart 解析", () => {
  it("主帳戶、罐子與定存分列，餘額沿用銀行顯示值", () => {
    const result = parseRichartPayloads(payloads(), now);
    expect(result.bankAccounts.map((account) => account.accountName)).toEqual([
      "Richart 台幣活存（末四碼 2345）",
      "Richart 子帳戶罐子（小查罐、萬用罐等）",
      "Richart 台幣定存",
    ]);
    expect(
      result.bankBalanceSnapshots.map(({ balance, availableBalance }) => ({
        balance,
        availableBalance,
      })),
    ).toEqual([
      { balance: 152300, availableBalance: 150000 },
      { balance: 8000, availableBalance: undefined },
      { balance: 100000, availableBalance: undefined },
    ]);
    expect(result.bankAccounts[0]?.sourceId).toMatch(
      /^bank:richart:2345:[0-9a-f]{8}:TWD$/,
    );
  });

  it("負數為支出、正數為存入，重疊月份不重複，同日同額交易保留兩筆", () => {
    const { bankTransactions } = parseRichartPayloads(payloads(), now);
    expect(
      bankTransactions.map(({ authorizedAt, amount, description }) => [
        authorizedAt,
        amount,
        description,
      ]),
    ).toEqual([
      ["2026-10-03", -120, "轉帳至 ****9012"],
      ["2026-10-01", 50000, "薪資"],
      ["2026-09-15", -85, "全家便利商店"],
      ["2026-09-15", -85, "全家便利商店"],
      ["2026-08-01", 3, "利息"],
    ]);
    expect(new Set(bankTransactions.map((tx) => tx.sourceId)).size).toBe(5);
  });

  it("重新同步產生相同 sourceId", () => {
    const first = parseRichartPayloads(payloads(), now).bankTransactions;
    const second = parseRichartPayloads(
      payloads(),
      new Date("2026-10-05T04:00:00.000Z"),
    ).bankTransactions;
    expect(second.map((tx) => tx.sourceId)).toEqual(
      first.map((tx) => tx.sourceId),
    );
  });

  it("沒有罐子或定存時不建立零餘額帳戶", () => {
    const result = parseRichartPayloads(
      payloads({
        subAccounts: { subAccountOverview: { hasSA: false, totalAmount: 0 } },
        twdTimeDeposits: { depositList: [], ntSumAmount: 0 },
      }),
      now,
    );
    expect(result.bankAccounts).toHaveLength(1);
  });

  it("缺少交易清單或帳號時視為格式錯誤，而非空資料", () => {
    expect(() => parseRichartTransactions("bank:richart:x", [{}], now)).toThrow(
      RichartApiError,
    );
    expect(() =>
      parseRichartPayloads(payloads({ savingAccount: { balance: 1 } }), now),
    ).toThrow(RichartApiError);
  });
});
