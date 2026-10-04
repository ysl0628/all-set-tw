import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";
import { RichartApiError, type RichartPayloads } from "./api";

/** 帳密之外只短暫保存人工檢核碼所需的 session 與 fakeSessionId。 */
export const richartConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  captchaSessionId: z.string().min(1).max(256).optional(),
  captchaCookies: z.record(z.string(), z.string()).optional(),
  captchaExpiresAt: z.number().int().optional(),
});
export type RichartConfig = z.infer<typeof richartConfigSchema>;
export function parseRichartConfig(value: unknown): RichartConfig {
  return richartConfigSchema.parse(value);
}

export type RichartData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

// Richart 是台新銀行的數位帳戶；與台新信用卡歸在同一機構。
const INSTITUTION = "台新銀行";

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
const text = z.string().nullish();

/** `/AccountService/getSavingAccount`：網銀首頁顯示的台幣活存餘額。 */
const savingAccountSchema = z.object({
  account: z.string().regex(/^\d{8,16}$/),
  balance: money,
  balanceAvailable: money.nullish(),
});

/** `/HistoryService/getTransaction`、`getNewTransaction` 的 `transLogList`。 */
const transactionPageSchema = z.object({
  transLogList: z.array(
    z.object({
      date: z.string().regex(/^\d{8}$/),
      // 官方網銀以 `amount < 0` 判斷支出，正值為存入。
      amount: money,
      balance: money.nullish(),
      title: text,
      content: text,
      memo: text,
      postScript: text,
    }),
  ),
});

/** `/SubAccountService/getSubAccount`：小查罐、萬用罐與證券罐另列於主帳戶外。 */
const subAccountSchema = z.object({
  subAccountOverview: z
    .object({
      hasSA: z.boolean().nullish(),
      totalAmount: money.nullish(),
    })
    .nullish(),
});

/** `/DepositService/getNtDepositOverviewForWebBank`。 */
const timeDepositSchema = z.object({
  depositList: z.array(z.unknown()).nullish(),
  ntSumAmount: money.nullish(),
});

export function parseRichartPayloads(
  payloads: RichartPayloads,
  now = new Date(),
): RichartData {
  if (!Number.isFinite(now.getTime())) {
    throw new RichartApiError("protocol", "parse");
  }
  const saving = savingAccountSchema.safeParse(payloads.savingAccount);
  if (!saving.success) throw new RichartApiError("protocol", "saving_account");
  const accountNo = saving.data.account;
  const accountId = `bank:richart:${accountNo.slice(-4)}:${hash(accountNo)}:TWD`;
  const asOfAt = now.toISOString();
  const result: RichartData = {
    bankAccounts: [
      {
        sourceId: accountId,
        institutionName: INSTITUTION,
        accountName: `Richart 台幣活存（末四碼 ${accountNo.slice(-4)}）`,
        accountType: "savings",
        currency: "TWD",
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId,
        sourceId: `snapshot:${accountId}`,
        balance: saving.data.balance,
        ...(saving.data.balanceAvailable != null
          ? { availableBalance: saving.data.balanceAvailable }
          : {}),
        currency: "TWD",
        asOfAt,
      },
    ],
    bankTransactions: parseRichartTransactions(
      accountId,
      payloads.transactionPages,
      now,
    ),
  };

  const jars = subAccountSchema.safeParse(payloads.subAccounts);
  if (!jars.success) throw new RichartApiError("protocol", "sub_accounts");
  const overview = jars.data.subAccountOverview;
  if (overview && overview.hasSA !== false && overview.totalAmount != null) {
    const jarId = `bank:richart:jars:${hash(accountNo)}:TWD`;
    result.bankAccounts.push({
      sourceId: jarId,
      institutionName: INSTITUTION,
      accountName: "Richart 子帳戶罐子（小查罐、萬用罐等）",
      accountType: "savings",
      currency: "TWD",
    });
    result.bankBalanceSnapshots.push({
      accountId: jarId,
      sourceId: `snapshot:${jarId}`,
      balance: overview.totalAmount,
      currency: "TWD",
      asOfAt,
    });
  }

  const deposits = timeDepositSchema.safeParse(payloads.twdTimeDeposits);
  if (!deposits.success) {
    throw new RichartApiError("protocol", "twd_time_deposits");
  }
  if ((deposits.data.depositList?.length ?? 0) > 0) {
    if (deposits.data.ntSumAmount == null) {
      throw new RichartApiError("protocol", "twd_time_deposits");
    }
    const depositId = `bank:richart:time:${hash(accountNo)}:TWD`;
    result.bankAccounts.push({
      sourceId: depositId,
      institutionName: INSTITUTION,
      accountName: "Richart 台幣定存",
      accountType: "time_deposit",
      currency: "TWD",
    });
    result.bankBalanceSnapshots.push({
      accountId: depositId,
      sourceId: `snapshot:${depositId}`,
      balance: deposits.data.ntSumAmount,
      currency: "TWD",
      asOfAt,
      raw: { depositCount: deposits.data.depositList?.length ?? 0 },
    });
  }
  return result;
}

/**
 * 最新交易與各月份回應可能重疊。同一頁內以出現次序區分相同交易，
 * 跨頁取各鍵最大的出現次數，避免重疊月份重複入帳。
 */
export function parseRichartTransactions(
  accountId: string,
  pages: unknown[],
  now = new Date(),
): RichartData["bankTransactions"] {
  const cutoff = syncStartDate(now);
  const merged = new Map<
    string,
    { count: number; row: RichartData["bankTransactions"][number] }
  >();
  for (const value of pages) {
    const page = transactionPageSchema.safeParse(value);
    if (!page.success) throw new RichartApiError("protocol", "transactions");
    const counts = new Map<string, number>();
    for (const item of page.data.transLogList) {
      const date = isoDate(item.date);
      const description =
        [item.title, item.content, item.memo, item.postScript]
          .map((part) => cleanText(part ?? ""))
          .find(Boolean) ?? "";
      const key = JSON.stringify([
        accountId,
        date,
        item.amount,
        description,
        item.balance ?? null,
      ]);
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      if (date < cutoff) continue;
      const existing = merged.get(key);
      if (existing && existing.count >= occurrence) continue;
      merged.set(key, {
        count: occurrence,
        row: {
          accountId,
          sourceId: "",
          authorizedAt: date,
          postedDate: date,
          amount: item.amount,
          currency: "TWD",
          description: description || "Richart 交易",
          status: "posted",
        },
      });
    }
  }
  const transactions: RichartData["bankTransactions"] = [];
  for (const [key, { count, row }] of merged) {
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      transactions.push({
        ...row,
        sourceId: `richart:tx:${hash(key)}:${occurrence}`,
      });
    }
  }
  return transactions;
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

function isoDate(value: string): string {
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new RichartApiError("protocol", "transactions");
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
