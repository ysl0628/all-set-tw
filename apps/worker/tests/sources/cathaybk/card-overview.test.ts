import { describe, expect, it } from "vitest";
import { parseCathayCardOverview } from "../../../src/sources/cathaybk/connector";

// 頁面文字為合成值。
const overview = [
  "信用卡總覽",
  "卡片末四碼：1234",
  "永久信用額度",
  "TWD 50,000",
  "剩餘可用額度",
  "TWD 41,000",
  "臺幣帳單 TWD 9,000",
  "繳款截止日 2026/10/20",
].join("\n");

describe("國泰世華信用卡總覽解析", () => {
  it("解析額度、應繳與繳款期限", () => {
    expect(parseCathayCardOverview(overview)).toEqual({
      cardDetected: true,
      last4: "1234",
      cardName: "國泰信用卡 末四碼 1234",
      creditLimit: 50000,
      availableCredit: 41000,
      unpaidAmount: 9000,
      paymentDueDate: "2026-10-20",
      noPaymentNeeded: false,
    });
  });

  it("沒有卡別字樣的長行不會讓解析變成平方時間", () => {
    const longLine = "國泰世華信用卡權益說明".repeat(20_000);
    const started = performance.now();
    const result = parseCathayCardOverview(`${longLine}\n${longLine}`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.cardDetected).toBe(false);
    expect(result.cardName).toBe("國泰信用卡");
  });

  it("找不到末四碼時以含卡別的那一行作為卡名", () => {
    expect(
      parseCathayCardOverview("說明\n國泰世華 CUBE 卡 VISA 御璽卡\n其他")
        .cardName,
    ).toBe("國泰世華 CUBE 卡 VISA 御璽卡");
  });
});
