import { describe, expect, it } from "vitest";
import {
  dateOf,
  moneyOf,
  parseHsbcCards,
  postedPageReachedCutoff,
  syncCutoffDate,
} from "../../../src/sources/hsbc/protocol";
import {
  hsbcCard,
  hsbcCardDetail,
  hsbcPostedPage0,
  hsbcPostedPage1,
  hsbcStatements,
  hsbcUnposted,
} from "./fixtures/cards";

const NOW = new Date("2026-10-03T04:00:00Z");

function parseFixture(
  overrides: Partial<Parameters<typeof parseHsbcCards>[0][number]> = {},
) {
  return parseHsbcCards(
    [
      {
        card: hsbcCard,
        detail: hsbcCardDetail,
        statements: hsbcStatements,
        unposted: hsbcUnposted,
        postedPages: [hsbcPostedPage0, hsbcPostedPage1],
        ...overrides,
      },
    ],
    NOW,
  );
}

describe("匯豐信用卡解析", () => {
  it("建立信用卡帳戶與餘額快照，欠款為負且不保留完整卡號或身分證", () => {
    const result = parseFixture();
    expect(result.bankAccounts).toHaveLength(1);
    const [account] = result.bankAccounts;
    expect(account).toMatchObject({
      institutionName: "匯豐銀行",
      accountType: "credit",
      currency: "TWD",
      creditLimit: 200000,
      accountName: expect.stringContaining("1234"),
    });
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      accountId: account?.sourceId,
      balance: -12345,
      availableBalance: 187655,
      statementBalance: 9876,
      paymentDueDate: "2026-09-27",
      statementClosingDate: "2026-09-09",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("A12***0000");
    expect(serialized).not.toContain("000000000000000");
  });

  it("只保留最近三期帳單，保留負額帳單的正負號", () => {
    const bills = parseFixture().creditCardBills;
    expect(bills.map((bill) => bill.billingPeriod)).toEqual([
      "2026-09",
      "2026-08",
      "2026-07",
    ]);
    expect(bills[0]).toMatchObject({
      statementAmount: 9876,
      minimumPayment: 1000,
      paymentDueDate: "2026-09-27",
      statementClosingDate: "2026-09-09",
      currency: "TWD",
    });
    expect(bills[2]?.statementAmount).toBe(-120);
    expect(bills.every((bill) => bill.isPaid === undefined)).toBe(true);
  });

  it("消費為負、繳款為正；佔位入帳日視為即時授權，且排除超過三個月的交易", () => {
    const transactions = parseFixture().bankTransactions;
    const byDescription = (text: string) =>
      transactions.filter((tx) => tx.description?.includes(text));

    const pending = byDescription("WWW.GRAB.COMBANGKOK");
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      amount: -140,
      currency: "TWD",
      authorizedAt: "2026-10-03",
      status: "pending",
      raw: { hsbcFeed: "unbilled", foreignAmount: 148, foreignCurrency: "THB" },
    });
    expect(pending[0]?.postedDate).toBeUndefined();

    expect(byDescription("測試商店")[0]).toMatchObject({
      amount: -1050,
      postedDate: "2026-09-12",
      status: "posted",
      raw: { hsbcFeed: "unbilled" },
    });
    expect(byDescription("全國繳費網繳款")[0]).toMatchObject({
      amount: 2500,
      status: "posted",
      raw: { hsbcFeed: "billed" },
    });
    expect(byDescription("回溯範圍內")).toHaveLength(1);
    expect(byDescription("超過三個月")).toHaveLength(0);
  });

  it("重複同步與翻頁順序改變時交易 ID 穩定，同日同額的兩筆消費仍分開保留", () => {
    const first = parseFixture().bankTransactions.map((tx) => tx.sourceId);
    const reordered = parseFixture({
      postedPages: [hsbcPostedPage1, hsbcPostedPage0],
    }).bankTransactions.map((tx) => tx.sourceId);
    expect(new Set(reordered)).toEqual(new Set(first));
    expect(new Set(first).size).toBe(first.length);
  });

  it("同一筆交易同時出現在已出帳與未出帳清單時只保留已出帳那筆", () => {
    const duplicated = {
      ...hsbcPostedPage0[0]!,
      postedDate: "2026-09-08T00:00",
    };
    const result = parseFixture({
      postedPages: [[duplicated]],
      unposted: [duplicated],
    });
    expect(result.bankTransactions).toHaveLength(1);
    expect(result.bankTransactions[0]?.raw).toMatchObject({
      hsbcFeed: "billed",
    });
  });

  it("交易方向或金額無法辨識時整批失敗，不提交部分結果", () => {
    expect(() =>
      parseFixture({
        unposted: [{ ...hsbcUnposted[0], isPositive: undefined }],
      }),
    ).toThrow("匯豐交易方向無法辨識");
    expect(() =>
      parseFixture({
        unposted: [{ ...hsbcUnposted[0], ntdAmount: "N/A", amount: "N/A" }],
      }),
    ).toThrow("匯豐交易金額無法辨識");
    expect(() => parseFixture({ unposted: null })).toThrow();
  });
});

describe("匯豐欄位格式", () => {
  it("解析金額字串與日期格式", () => {
    expect(moneyOf("2,500 TWD")).toEqual({ amount: 2500, currency: "TWD" });
    expect(moneyOf("148 THB")).toEqual({ amount: 148, currency: "THB" });
    expect(moneyOf("-120")).toEqual({ amount: -120, currency: "TWD" });
    expect(moneyOf("N/A")).toBeUndefined();
    expect(dateOf("2026-10-03T00:00")).toBe("2026-10-03");
    expect(dateOf("2025/10/27")).toBe("2025-10-27");
    expect(dateOf("27-09-2026")).toBe("2026-09-27");
    expect(dateOf("0002-11-30T00:00")).toBeUndefined();
    expect(dateOf("2026-02-30")).toBeUndefined();
  });

  it("回溯起日以臺灣日期計算，整頁早於起日才停止翻頁", () => {
    expect(syncCutoffDate(new Date("2026-10-02T17:00:00Z"))).toBe("2026-07-03");
    expect(postedPageReachedCutoff(hsbcPostedPage1, "2026-07-03")).toBe(false);
    expect(postedPageReachedCutoff(hsbcPostedPage1, "2026-07-05")).toBe(true);
    expect(postedPageReachedCutoff([], "2026-07-03")).toBe(true);
  });
});
