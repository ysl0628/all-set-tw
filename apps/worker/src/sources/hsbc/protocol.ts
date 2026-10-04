import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";

/** 匯豐信用卡網路服務登入後只需要使用者代號與密碼；待提交的瀏覽器工作階段僅短暫加密保存。 */
export const hsbcConfigSchema = z.object({
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  captchaKey: z.string().min(1).optional(),
  browserSessionId: z.string().max(256).optional(),
  captchaExpiresAt: z.number().int().optional(),
});
export type HsbcConfig = z.infer<typeof hsbcConfigSchema>;
export function parseHsbcConfig(value: unknown): HsbcConfig {
  return hsbcConfigSchema.parse(value);
}

type JsonRecord = Record<string, unknown>;
type Account = Omit<BankAccount, "id" | "connectorId">;
type Snapshot = Omit<BankBalanceSnapshot, "id" | "connectorId">;
type Transaction = Omit<BankTransaction, "id" | "connectorId">;
type Bill = Omit<CreditCardBill, "id" | "connectorId">;

export class HsbcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HsbcParseError";
  }
}

export type HsbcCardPayloads = {
  /** `GET /api/v1/cards` 中的單張卡片。 */
  card: unknown;
  /** `GET /api/v1/cards/{id}` 的 payload。 */
  detail: unknown;
  /** `GET /api/v1/cards/{id}/view-statement` 的 payload。 */
  statements: unknown;
  /** `GET /api/v1/cards/{id}/transactions/unposted` 的 payload。 */
  unposted: unknown;
  /** `GET /api/v1/cards/{id}/transactions/posted` 各頁的 `content`。 */
  postedPages: unknown[];
};

export type HsbcData = {
  bankAccounts: Account[];
  bankBalanceSnapshots: Snapshot[];
  bankTransactions: Transaction[];
  creditCardBills: Bill[];
};

const INSTITUTION = "匯豐銀行";

export function parseHsbcCards(
  cards: HsbcCardPayloads[],
  now = new Date(),
): HsbcData {
  const asOfAt = now.toISOString();
  const cutoff = syncCutoffDate(now);
  const result: HsbcData = {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    bankTransactions: [],
    creditCardBills: [],
  };
  for (const payload of cards) {
    const card = requireRecord(payload.card, "卡片");
    const cardId = requiredString(card, "id", "卡片識別碼");
    const last4 = last4Of(stringAt(card, "maskedCardNumber"));
    if (!last4) throw new HsbcParseError("匯豐卡號末四碼無法辨識。");
    const accountId = `hsbc:credit:${last4}:${hash(cardId)}`;
    const name = stringAt(card, "name") || "匯豐信用卡";
    const details = detailMap(payload.detail);
    const creditLimit = moneyOf(details.get("credit limit"))?.amount;
    result.bankAccounts.push({
      sourceId: accountId,
      institutionName: INSTITUTION,
      accountName: `${name}（末四碼 ${last4}）`,
      accountType: "credit",
      currency: "TWD",
      ...(creditLimit !== undefined ? { creditLimit } : {}),
      raw: {
        last4,
        isPrimaryCard: card.isPrimaryCard === true,
        cardStatus: stringAt(card, "cardStatusDisplay") || undefined,
      },
    });

    const bills = parseStatements(payload.statements, accountId);
    result.creditCardBills.push(...bills);

    const outstanding = numberOf(card.outstandingBalance);
    if (outstanding === undefined) {
      throw new HsbcParseError("匯豐信用卡應繳餘額無法辨識。");
    }
    const available = moneyOf(details.get("available credit limit"))?.amount;
    const latestBill = bills[0];
    result.bankBalanceSnapshots.push({
      accountId,
      sourceId: `${accountId}:${asOfAt}`,
      // 銀行 `outstandingBalance` 為卡片主畫面顯示的目前金額，正值代表欠款。
      balance: -outstanding,
      ...(available !== undefined ? { availableBalance: available } : {}),
      ...(latestBill?.statementAmount !== undefined
        ? { statementBalance: latestBill.statementAmount }
        : {}),
      ...(dateOf(card.paymentDueDate)
        ? { paymentDueDate: dateOf(card.paymentDueDate) }
        : {}),
      ...(latestBill?.statementClosingDate
        ? { statementClosingDate: latestBill.statementClosingDate }
        : {}),
      currency: "TWD",
      asOfAt,
    });

    const billed = parseTransactions(
      payload.postedPages.flatMap((page, index) =>
        arrayOf(page, `已出帳交易第 ${index + 1} 頁`),
      ),
      accountId,
      "billed",
      cutoff,
    );
    const unbilled = parseTransactions(
      arrayOf(payload.unposted, "未出帳交易"),
      accountId,
      "unbilled",
      cutoff,
    );
    // 同一筆交易若同時出現在兩份清單，以已出帳資料為準。
    result.bankTransactions.push(...dedupe([...billed, ...unbilled]));
  }
  return result;
}

/** 回溯起日：臺灣當日往前 BANK_SYNC_MONTHS 個月，日期格式 YYYY-MM-DD。 */
export function syncCutoffDate(now: Date): string {
  const taiwan = new Date(now.getTime() + 8 * 3600_000);
  const start = new Date(
    Date.UTC(
      taiwan.getUTCFullYear(),
      taiwan.getUTCMonth() - BANK_SYNC_MONTHS,
      taiwan.getUTCDate(),
    ),
  );
  return start.toISOString().slice(0, 10);
}

/** 已出帳交易依消費日由新到舊排列；整頁都早於回溯起日時即可停止翻頁。 */
export function postedPageReachedCutoff(
  content: unknown,
  cutoff: string,
): boolean {
  if (!Array.isArray(content) || content.length === 0) return true;
  const dates = content
    .map((row) => (isRecord(row) ? dateOf(row.transactionDate) : undefined))
    .filter((date): date is string => Boolean(date));
  return dates.length > 0 && dates.every((date) => date < cutoff);
}

function parseStatements(value: unknown, accountId: string): Bill[] {
  const rows = arrayOf(value, "帳單").map((row) => requireRecord(row, "帳單"));
  const byPeriod = new Map<string, Bill>();
  for (const row of rows) {
    const year = stringAt(row, "stmtYr");
    const month = stringAt(row, "stmtMo").padStart(2, "0");
    if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
      throw new HsbcParseError("匯豐帳單月份無法辨識。");
    }
    const billingPeriod = `${year}-${month}`;
    const statementAmount = numberOf(row.curTotAmt);
    if (statementAmount === undefined) {
      throw new HsbcParseError("匯豐帳單應繳總額無法辨識。");
    }
    const minimumPayment = numberOf(row.minAmt);
    const paymentDueDate = dateOf(row.pmtDue);
    const statementClosingDate = dateOf(row.stmtDate);
    byPeriod.set(billingPeriod, {
      accountId,
      sourceId: `${accountId}:bill:${billingPeriod}`,
      billingPeriod,
      statementAmount,
      ...(minimumPayment !== undefined ? { minimumPayment } : {}),
      ...(paymentDueDate ? { paymentDueDate } : {}),
      ...(statementClosingDate ? { statementClosingDate } : {}),
      currency: "TWD",
    });
  }
  return [...byPeriod.values()]
    .sort((a, b) => b.billingPeriod.localeCompare(a.billingPeriod))
    .slice(0, BANK_SYNC_MONTHS);
}

function parseTransactions(
  rows: unknown[],
  accountId: string,
  feed: "billed" | "unbilled",
  cutoff: string,
): Transaction[] {
  const occurrences = new Map<string, number>();
  const transactions: Transaction[] = [];
  for (const value of rows) {
    const row = requireRecord(value, "交易");
    const date = dateOf(row.transactionDate);
    if (!date) throw new HsbcParseError("匯豐交易消費日無法辨識。");
    if (date < cutoff) continue;
    const ntd = moneyOf(row.ntdAmount) ?? moneyOf(row.amount);
    if (!ntd) throw new HsbcParseError("匯豐交易金額無法辨識。");
    if (typeof row.isPositive !== "boolean") {
      throw new HsbcParseError("匯豐交易方向無法辨識。");
    }
    // `isPositive` 為 true 是消費（增加欠款），false 是繳款、退款或調整。
    const amount = row.isPositive
      ? -Math.abs(ntd.amount)
      : Math.abs(ntd.amount);
    const description = cleanDescription(stringAt(row, "description"));
    const foreign =
      row.isForeign === true ? moneyOf(row.foreignAmount) : undefined;
    const postedDate = dateOf(row.postedDate);
    const key = [
      accountId,
      date,
      description,
      amount,
      foreign ? `${foreign.amount}${foreign.currency}` : "",
    ].join("|");
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    transactions.push({
      accountId,
      sourceId: `hsbc:card:tx:${hash(key)}:${occurrence}`,
      authorizedAt: date,
      ...(postedDate ? { postedDate } : {}),
      amount,
      currency: ntd.currency,
      description: description || "匯豐信用卡交易",
      status: postedDate ? "posted" : "pending",
      raw: {
        hsbcFeed: feed,
        ...(foreign
          ? {
              foreignAmount: foreign.amount,
              foreignCurrency: foreign.currency,
            }
          : {}),
      },
    });
  }
  return transactions;
}

function detailMap(value: unknown): Map<string, unknown> {
  const details = new Map<string, unknown>();
  if (!isRecord(value) || !Array.isArray(value.details)) return details;
  for (const item of value.details) {
    if (!isRecord(item) || typeof item.key !== "string") continue;
    details.set(item.key.trim().toLowerCase(), item.value);
  }
  return details;
}

function cleanDescription(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\d{10,}/g, (digits) => `****${digits.slice(-4)}`);
}

/** 解析 `"2,500 TWD"`、`"148 THB"`、`98334` 或 `"98,334"`。 */
export function moneyOf(
  value: unknown,
): { amount: number; currency: string } | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { amount: value, currency: "TWD" }
      : undefined;
  }
  if (typeof value !== "string") return undefined;
  const match = /^\s*([+-]?[\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*$/.exec(value);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(amount)) return undefined;
  return { amount, currency: (match[2] ?? "TWD").toUpperCase() };
}

function numberOf(value: unknown): number | undefined {
  const money = moneyOf(value);
  return money && money.currency === "TWD" ? money.amount : undefined;
}

/**
 * 接受 `2026-10-03T00:00`、`2025/10/27` 與 `27-09-2026`；
 * 銀行以 `0002-11-30` 表示尚未入帳，年份早於 1900 一律視為沒有日期。
 */
export function dateOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  const dmy = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(text);
  if (ymd) [, year, month, day] = ymd;
  else if (dmy) [, day, month, year] = dmy;
  if (!year || !month || !day || Number(year) < 1900) return undefined;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? undefined
    : date;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new HsbcParseError(`匯豐${label}格式無法辨識。`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new HsbcParseError(`匯豐${label}格式無法辨識。`);
  return value;
}

function requiredString(row: JsonRecord, key: string, label: string): string {
  const value = row[key];
  const text = typeof value === "number" ? String(value) : stringAt(row, key);
  if (!text) throw new HsbcParseError(`匯豐${label}無法辨識。`);
  return text;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringAt(row: JsonRecord, key: string): string {
  return typeof row[key] === "string" ? row[key].trim() : "";
}

function last4Of(masked: string): string {
  return /(\d{4})\D*$/.exec(masked)?.[1] ?? "";
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function dedupe<T extends { sourceId: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows)
    if (!seen.has(row.sourceId)) seen.set(row.sourceId, row);
  return [...seen.values()];
}
