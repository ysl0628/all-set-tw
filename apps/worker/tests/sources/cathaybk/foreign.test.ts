import { describe, expect, it } from "vitest";
import {
  CathayForeignProtocolError,
  cathayForeignTargets,
  parseCathayForeignPayloads,
} from "../../../src/sources/cathaybk/foreign";

// 結構取自去識別化的網銀回應；帳號、金額與日期皆為合成值。
const asOfAt = "2026-10-05T08:00:00.000Z";

const overview = {
  content: {
    isGetDemandAccountSuccess: true,
    demandAccounts: [
      {
        account: "012345678901",
        demandType: "ComprehensiveDeposit",
        status: "Normal",
        details: [
          { currencyCode: "JPY", currency: "日幣", balance: 120000 },
          { currencyCode: "USD", currency: "美元", balance: 25.5 },
        ],
      },
    ],
    isGetDepositAccountSuccess: true,
    depositAccounts: [],
  },
  success: true,
  returnCode: "0000",
};

function detail(currency: string, infos: unknown[]) {
  return {
    account: "012345678901",
    currency,
    response: {
      content: {
        transferDetails: [{ currencyCode: currency, transferInfos: infos }],
      },
      success: true,
      returnCode: "0000",
    },
  };
}

describe("國泰世華外幣活存", () => {
  it("每個幣別各為一個帳戶，與臺幣帳戶 sourceId 區隔", () => {
    const result = parseCathayForeignPayloads(
      { overview, details: [] },
      asOfAt,
    );
    expect(
      result.bankAccounts.map(({ sourceId, accountName, currency }) => ({
        sourceId,
        accountName,
        currency,
      })),
    ).toEqual([
      {
        sourceId: "bank:cathaybk:012345678901:JPY",
        accountName: "外幣活存 日幣",
        currency: "JPY",
      },
      {
        sourceId: "bank:cathaybk:012345678901:USD",
        accountName: "外幣活存 美元",
        currency: "USD",
      },
    ]);
    expect(result.bankBalanceSnapshots.map((s) => s.balance)).toEqual([
      120000, 25.5,
    ]);
    expect(cathayForeignTargets(overview)).toEqual([
      { account: "012345678901", currency: "JPY" },
      { account: "012345678901", currency: "USD" },
    ]);
  });

  it("正負號依 debitCreditType，時間視為臺灣當地時間", () => {
    const result = parseCathayForeignPayloads(
      {
        overview,
        details: [
          detail("JPY", [
            {
              sequenceNumber: 0,
              transferDate: "2026-09-19T01:31:28",
              debitCreditType: "Credit",
              amount: 30,
              balance: 120000,
              memo: "付息",
            },
            {
              sequenceNumber: 1,
              transferDate: "2026-09-02T10:00:00",
              debitCreditType: "Debit",
              amount: 5000,
              balance: 119970,
              memo: "外幣轉出",
            },
          ]),
        ],
      },
      asOfAt,
    );
    expect(
      result.bankTransactions.map(
        ({ amount, currency, postedDate, authorizedAt }) => ({
          amount,
          currency,
          postedDate,
          authorizedAt,
        }),
      ),
    ).toEqual([
      {
        amount: 30,
        currency: "JPY",
        postedDate: "2026-09-19",
        authorizedAt: "2026-09-19T01:31:28+08:00",
      },
      {
        amount: -5000,
        currency: "JPY",
        postedDate: "2026-09-02",
        authorizedAt: "2026-09-02T10:00:00+08:00",
      },
    ]);
  });

  it("總覽查詢失敗或明細格式不符時拒絕解析", () => {
    expect(() =>
      parseCathayForeignPayloads(
        {
          overview: {
            ...overview,
            content: { ...overview.content, isGetDemandAccountSuccess: false },
          },
          details: [],
        },
        asOfAt,
      ),
    ).toThrow(CathayForeignProtocolError);
    expect(() =>
      parseCathayForeignPayloads(
        {
          overview,
          details: [
            detail("JPY", [
              {
                transferDate: "2026-09-19T01:31:28",
                debitCreditType: "Unknown",
                amount: 1,
              },
            ]),
          ],
        },
        asOfAt,
      ),
    ).toThrow(CathayForeignProtocolError);
  });
});
