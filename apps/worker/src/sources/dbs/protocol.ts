import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";

const INSTITUTION = "星展銀行";

/** 網銀 1FA 只需使用者代號與密碼；不保存任何 session 或 token。 */
export const dbsConfigSchema = z.object({
  account: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(128).optional(),
});
export type DbsConfig = z.infer<typeof dbsConfigSchema>;
export function parseDbsConfig(value: unknown): DbsConfig {
  return dbsConfigSchema.parse(value);
}

export class DbsProtocolError extends Error {
  constructor(readonly operation: string) {
    super(`星展回應格式不符：${operation}`);
    this.name = "DbsProtocolError";
  }
}

export type DbsData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

/** 登入後取得的唯讀回應；交易依 `globalAccountId` 分組，每組含各月份與分頁。 */
export type DbsPayloads = {
  assets: unknown;
  liabilities?: unknown;
  transactions: Array<{ globalAccountId: string; pages: unknown[] }>;
};

/** 帳戶在本次登入可查詢明細的 `globalAccountId` 與幣別（`currencyWallet`）。 */
export type DbsTransactionTarget = {
  globalAccountId: string;
  currency: string;
};

const money = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\s*-?[\d,]+(?:\.\d+)?\s*$/)
      .transform((value) => value.replaceAll(",", "")),
  ])
  .transform(Number)
  .refine(Number.isFinite);
const currency = z.string().regex(/^[A-Z]{3}$/);
/** 星展時間為 `yyyy-MM-dd'T'HH:mm:ssZ`（如 `+0800`）或 `yyyy-MM-dd`。 */
const dated = z.object({
  value: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:]{8}[+-]\d{4})?$/),
});

/**
 * `dashboard/channels/customerFinancialOverview/assets`（x-version 3.0.0）的活存。
 * `multiCurrencyAccountFlag` 為 true 的外幣總戶沒有幣別與餘額，實際餘額在各幣別子帳戶。
 */
const casaAccountSchema = z.object({
  globalAccountId: z.string().min(1),
  accountStatus: z.string().nullish(),
  schemeName: z.string().nullish(),
  accountOpenedDate: dated.nullish(),
  multiCurrencyAccountFlag: z.boolean().nullish(),
  displayAccountNumber: z.string().nullish(),
  availableBalance: z
    .object({ currency: z.string().nullish(), balance: money.nullish() })
    .nullish(),
  ledgerBalance: z
    .object({ currency: z.string().nullish(), balance: money.nullish() })
    .nullish(),
});
const assetsSchema = z.object({
  casa: z
    .object({ accounts: z.array(z.unknown()).nullish(), status: z.string() })
    .nullish(),
});

/** `dashboard/channels/customerFinancialOverview/liabilities`：整個卡戶一筆應繳。 */
const liabilitiesSchema = z.object({
  creditCard: z
    .object({
      cards: z.array(z.unknown()).nullish(),
      paymentDetails: z
        .object({
          amount: money,
          dueDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullish(),
          minimumAmount: money.nullish(),
          alreadyPaid: money.nullish(),
          currency: currency.nullish(),
        })
        .nullish(),
      status: z.string().nullish(),
    })
    .nullish(),
});

/** `deposit-accounts/transactions-history/inquiry`（x-version 1.2.0）。 */
const transactionPageSchema = z.object({
  pageInfo: z.object({ nextCursor: z.unknown() }).nullish(),
  transactions: z.array(
    z.object({
      // `displayBalance` 在明細固定為 0，金額以字串 `balance` 為準。
      amount: z.object({ currency: currency.nullish(), balance: money }),
      side: z.enum(["D", "C"]),
      description: z.object({ textValue: z.string().nullish() }).nullish(),
      remarks: z.string().nullish(),
      postedDate: dated.nullish(),
      transactionDate: dated,
      transactionReferenceNumber: z.string().nullish(),
      runningBalance: z.object({ balance: money.nullish() }).nullish(),
    }),
  ),
});

type CasaAccount = z.infer<typeof casaAccountSchema>;

/** 可查明細且有實際餘額的活存（排除外幣總戶與非使用中帳戶）。 */
function activeCasaAccounts(assets: unknown): CasaAccount[] {
  const parsed = assetsSchema.safeParse(assets);
  if (!parsed.success) throw new DbsProtocolError("assets");
  if (!parsed.data.casa) return [];
  if (parsed.data.casa.status !== "SUCCESS") {
    throw new DbsProtocolError("assets");
  }
  return (parsed.data.casa.accounts ?? []).flatMap((value) => {
    const account = casaAccountSchema.safeParse(value);
    if (!account.success) throw new DbsProtocolError("assets");
    if (account.data.multiCurrencyAccountFlag) return [];
    if (account.data.accountStatus && account.data.accountStatus !== "A") {
      return [];
    }
    return [account.data];
  });
}

/** 供 API client 決定要查詢哪些帳戶的明細。 */
export function dbsTransactionTargets(assets: unknown): DbsTransactionTarget[] {
  return activeCasaAccounts(assets).map((account) => ({
    globalAccountId: account.globalAccountId,
    currency: accountCurrency(account),
  }));
}

/**
 * `globalAccountId` 是登入期間的不透明代號，不保證跨 session 不變；
 * 帳戶身分以顯示帳號（末四碼加雜湊）與幣別決定。
 */
export function parseDbsPayloads(
  payloads: DbsPayloads,
  now = new Date(),
): DbsData {
  if (!Number.isFinite(now.getTime())) throw new DbsProtocolError("parse");
  const asOfAt = now.toISOString();
  const result: DbsData = {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    bankTransactions: [],
  };
  const accountIds = new Map<string, { id: string; currency: string }>();

  for (const account of activeCasaAccounts(payloads.assets)) {
    const accountNo = account.displayAccountNumber?.replace(/\D/g, "") ?? "";
    if (accountNo.length < 8) throw new DbsProtocolError("assets");
    const accountCurrencyCode = accountCurrency(account);
    const balance = account.ledgerBalance?.balance;
    if (balance == null) throw new DbsProtocolError("assets");
    const last4 = accountNo.slice(-4);
    const id = `bank:dbs:${last4}:${hash(accountNo)}:${accountCurrencyCode}`;
    accountIds.set(account.globalAccountId, {
      id,
      currency: accountCurrencyCode,
    });
    const opened = account.accountOpenedDate?.value.slice(0, 10);
    result.bankAccounts.push({
      sourceId: id,
      institutionName: INSTITUTION,
      // 帳戶 `accountName` 是戶名，只用商品名稱顯示。
      accountName: `${account.schemeName?.trim() || "星展存款"}（末四碼 ${last4}）`,
      accountType: "savings",
      currency: accountCurrencyCode,
      ...(opened ? { openedDate: opened } : {}),
    });
    const available = account.availableBalance?.balance;
    result.bankBalanceSnapshots.push({
      accountId: id,
      sourceId: `snapshot:${id}`,
      balance,
      ...(available != null ? { availableBalance: available } : {}),
      currency: accountCurrencyCode,
      asOfAt,
    });
  }

  for (const group of payloads.transactions) {
    const account = accountIds.get(group.globalAccountId);
    if (!account) throw new DbsProtocolError("transactions");
    result.bankTransactions.push(
      ...parseDbsTransactions(account.id, account.currency, group.pages, now),
    );
  }

  if (payloads.liabilities !== undefined) {
    const card = parseDbsCreditCard(payloads.liabilities, asOfAt);
    if (card) {
      result.bankAccounts.push(card.account);
      result.bankBalanceSnapshots.push(card.snapshot);
    }
  }
  return result;
}

/**
 * 每個月份分開查詢，跨頁或跨月份可能重複；以銀行交易序號加內容去重。
 * 回溯區間依 `transactionDate`（銀行查詢的篩選依據）判斷。
 */
export function parseDbsTransactions(
  accountId: string,
  accountCurrencyCode: string,
  pages: unknown[],
  now = new Date(),
): DbsData["bankTransactions"] {
  const cutoff = syncStartDate(now);
  const merged = new Map<string, DbsData["bankTransactions"][number]>();
  for (const value of pages) {
    const page = transactionPageSchema.safeParse(value);
    if (!page.success) throw new DbsProtocolError("transactions");
    for (const item of page.data.transactions) {
      const date = isoDate(item.transactionDate.value);
      if (date < cutoff) continue;
      const amount =
        item.side === "D" ? -item.amount.balance : item.amount.balance;
      const description = [item.description?.textValue, item.remarks]
        .map((part) => cleanText(part ?? ""))
        .filter(Boolean)
        .join(" ");
      const reference = item.transactionReferenceNumber?.trim() ?? "";
      const key = JSON.stringify([
        accountId,
        reference,
        date,
        amount,
        description,
        item.runningBalance?.balance ?? null,
      ]);
      if (merged.has(key)) continue;
      const posted = item.postedDate?.value;
      merged.set(key, {
        accountId,
        sourceId: `dbs:tx:${hash(key)}`,
        authorizedAt: date,
        postedDate: posted ? isoDate(posted) : date,
        amount,
        currency: item.amount.currency ?? accountCurrencyCode,
        description: description || "星展交易",
        status: "posted",
      });
    }
  }
  return [...merged.values()];
}

/** 是否還有下一頁；`nextCursor` 為 null 或空字串時結束。 */
export function dbsNextCursor(page: unknown): string | number | null {
  const parsed = transactionPageSchema.safeParse(page);
  if (!parsed.success) throw new DbsProtocolError("transactions");
  const next = parsed.data.pageInfo?.nextCursor;
  if (typeof next === "number" && Number.isFinite(next)) return next;
  if (typeof next === "string" && next.trim()) return next.trim();
  return null;
}

/**
 * 星展信用卡應繳以整個卡戶計算，`paymentDetails` 只有一筆；
 * 以單一卡戶帳戶表示，避免多張卡各自缺少負債資料。只含已出帳應繳，不含未出帳消費。
 */
function parseDbsCreditCard(
  liabilities: unknown,
  asOfAt: string,
): {
  account: DbsData["bankAccounts"][number];
  snapshot: DbsData["bankBalanceSnapshots"][number];
} | null {
  const parsed = liabilitiesSchema.safeParse(liabilities);
  if (!parsed.success) throw new DbsProtocolError("liabilities");
  const credit = parsed.data.creditCard;
  if (!credit || (credit.cards?.length ?? 0) === 0) return null;
  if (credit.status !== "SUCCESS" || !credit.paymentDetails) {
    throw new DbsProtocolError("liabilities");
  }
  const details = credit.paymentDetails;
  const cardCurrency = details.currency ?? "TWD";
  const id = `credit:dbs:main`;
  const outstanding = Math.max(0, details.amount - (details.alreadyPaid ?? 0));
  return {
    account: {
      sourceId: id,
      institutionName: INSTITUTION,
      accountName: "星展信用卡",
      accountType: "credit",
      currency: cardCurrency,
    },
    snapshot: {
      accountId: id,
      sourceId: `snapshot:${id}`,
      balance: -outstanding,
      statementBalance: details.amount,
      ...(details.dueDate ? { paymentDueDate: details.dueDate } : {}),
      noPaymentNeeded: outstanding === 0,
      currency: cardCurrency,
      asOfAt,
      raw: { cardCount: credit.cards?.length ?? 0 },
    },
  };
}

function accountCurrency(account: CasaAccount): string {
  const code =
    account.ledgerBalance?.currency ?? account.availableBalance?.currency;
  if (!code || !/^[A-Z]{3}$/.test(code)) throw new DbsProtocolError("assets");
  return code;
}

/** 臺灣當月往前 BANK_SYNC_MONTHS - 1 個月的第一天。 */
function syncStartDate(now: Date): string {
  const taiwan = new Date(now.getTime() + 8 * 3600_000);
  return new Date(
    Date.UTC(
      taiwan.getUTCFullYear(),
      taiwan.getUTCMonth() - BANK_SYNC_MONTHS + 1,
      1,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

/** 取銀行當地日期部分，不經 `Date` 解析 `+0800` 時區格式。 */
function isoDate(value: string): string {
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new DbsProtocolError("transactions");
  }
  return date;
}

function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[A-Z][12]\d{8}/gi, "[身分證已遮罩]")
    .replace(/\d{10,}/g, (digits) => `****${digits.slice(-4)}`);
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
