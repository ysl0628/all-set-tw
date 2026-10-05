import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/shared";
import type { Page } from "@cloudflare/puppeteer";
import { z } from "zod";

/** 外幣存款總覽頁；頁面腳本會載入 `ClientForeign` API 所需的登入狀態。 */
export const FOREIGN_DEPOSIT_OVERVIEW_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/FAcctInq/R0101_FDepInq";

export type CathayForeignData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

/** 外幣帳戶的原始回應：總覽一份，明細依帳號與幣別各一份。 */
export type CathayForeignPayloads = {
  overview: unknown;
  details: Array<{ account: string; currency: string; response: unknown }>;
};

export class CathayForeignProtocolError extends Error {
  constructor(readonly operation: string) {
    super(`國泰世華外幣回應格式不符：${operation}`);
    this.name = "CathayForeignProtocolError";
  }
}

const success = z.object({ success: z.literal(true), returnCode: z.string() });

/** `ClientForeign/R_ACCT_Q_OverView`：外幣活存依帳號分組，每個幣別一筆餘額。 */
const overviewSchema = success.extend({
  content: z.object({
    isGetDemandAccountSuccess: z.boolean(),
    demandAccounts: z
      .array(
        z.object({
          account: z.string().regex(/^\d{8,16}$/),
          demandType: z.string().nullish(),
          status: z.string().nullish(),
          details: z.array(
            z.object({
              currencyCode: z.string().regex(/^[A-Z]{3}$/),
              currency: z.string().nullish(),
              balance: z.number().finite(),
            }),
          ),
        }),
      )
      .nullish(),
    depositAccounts: z.array(z.unknown()).nullish(),
  }),
});

/** `ClientForeign/R_ACCT_Q_TransferDetail`：金額為正值，方向看 `debitCreditType`。 */
const transferDetailSchema = success.extend({
  content: z.object({
    transferDetails: z.array(
      z.object({
        currencyCode: z.string(),
        transferInfos: z.array(
          z.object({
            sequenceNumber: z.number().nullish(),
            transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
            debitCreditType: z.enum(["Debit", "Credit"]),
            amount: z.number().finite(),
            balance: z.number().finite().nullish(),
            memo: z.string().nullish(),
          }),
        ),
      }),
    ),
  }),
});

/** 外幣活存清單（帳號與幣別），供決定要查詢哪些明細。 */
export function cathayForeignTargets(
  overview: unknown,
): Array<{ account: string; currency: string }> {
  return demandAccounts(overview).flatMap((account) =>
    account.details.map((detail) => ({
      account: account.account,
      currency: detail.currencyCode,
    })),
  );
}

function demandAccounts(overview: unknown) {
  const parsed = overviewSchema.safeParse(overview);
  if (!parsed.success || !parsed.data.content.isGetDemandAccountSuccess) {
    throw new CathayForeignProtocolError("overview");
  }
  return parsed.data.content.demandAccounts ?? [];
}

/**
 * 每個帳號的每個幣別是一個帳戶，sourceId 為 `bank:cathaybk:<帳號>:<幣別>`，
 * 與臺幣帳戶的 `bank:cathaybk:<帳號>` 區隔。外幣定存回應格式尚未確認，未接入。
 */
export function parseCathayForeignPayloads(
  payloads: CathayForeignPayloads,
  asOfAt: string,
): CathayForeignData {
  const result: CathayForeignData = {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    bankTransactions: [],
  };
  const accountIds = new Map<string, string>();
  for (const account of demandAccounts(payloads.overview)) {
    for (const detail of account.details) {
      const sourceId = `bank:cathaybk:${account.account}:${detail.currencyCode}`;
      accountIds.set(`${account.account}:${detail.currencyCode}`, sourceId);
      result.bankAccounts.push({
        sourceId,
        institutionName: "國泰世華銀行",
        accountName: `外幣活存 ${detail.currency?.trim() || detail.currencyCode}`,
        accountType: "savings",
        currency: detail.currencyCode,
      });
      result.bankBalanceSnapshots.push({
        accountId: sourceId,
        sourceId: `${sourceId}:${asOfAt}`,
        balance: detail.balance,
        currency: detail.currencyCode,
        asOfAt,
      });
    }
  }

  for (const item of payloads.details) {
    const accountId = accountIds.get(`${item.account}:${item.currency}`);
    if (!accountId) throw new CathayForeignProtocolError("transfer_detail");
    const parsed = transferDetailSchema.safeParse(item.response);
    if (!parsed.success) {
      throw new CathayForeignProtocolError("transfer_detail");
    }
    const seen = new Map<string, number>();
    for (const group of parsed.data.content.transferDetails) {
      if (group.currencyCode !== item.currency) continue;
      for (const info of group.transferInfos) {
        const date = info.transferDate.slice(0, 10);
        const amount =
          info.debitCreditType === "Debit" ? -info.amount : info.amount;
        const description = info.memo?.trim() || "國泰世華外幣交易";
        const key = [date, accountId, amount, description, info.balance].join(
          ":",
        );
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        result.bankTransactions.push({
          accountId,
          sourceId: `${key}:${occurrence}`,
          postedDate: date,
          // 銀行時間未帶時區，為臺灣當地時間。
          authorizedAt: `${info.transferDate.slice(0, 19)}+08:00`,
          amount,
          currency: item.currency,
          description,
          status: "posted",
        });
      }
    }
  }
  return result;
}

/**
 * 在外幣總覽頁內以網銀的 JWT 呼叫 `ClientForeign` API；
 * 只讀取總覽與各幣別明細，不呼叫任何交易功能。
 */
export async function collectCathayForeignPayloads(
  page: Page,
  lookbackDays: number,
): Promise<CathayForeignPayloads | null> {
  await page.goto(FOREIGN_DEPOSIT_OVERVIEW_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  if (page.url().includes("/logout/")) {
    throw new Error("Cathay Bank forced logout on foreign deposit page.");
  }
  const raw = (await page.evaluate(async (days: number) => {
    const jwt = await new Promise<{ token: string; customerId: string }>(
      (resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/MyBank/Customized/GetJWT");
        xhr.withCredentials = true;
        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText).Data;
            resolve({ token: data.JwtToken, customerId: data.CustomerId });
          } catch {
            resolve({ token: "", customerId: "" });
          }
        };
        xhr.onerror = () => resolve({ token: "", customerId: "" });
        xhr.send();
      },
    );
    if (!jwt.token) return null;

    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const functionSeqNo = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${crypto.randomUUID()}`;
    const localDate = (date: Date) =>
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

    function post(endpoint: string, content: Record<string, unknown>) {
      return new Promise<unknown>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
          "POST",
          `/OnlineBankingApi/ClientForeign/Api/ClientForeign/${endpoint}`,
        );
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", `Bearer ${jwt.token}`);
        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve(null);
          }
        };
        xhr.onerror = () => resolve(null);
        xhr.send(JSON.stringify({ functionSeqNo, content }));
      });
    }

    const overview = (await post("R_ACCT_Q_OverView", {
      customerId: jwt.customerId,
    })) as {
      content?: {
        demandAccounts?: Array<{
          account?: string;
          details?: Array<{ currencyCode?: string }>;
        }> | null;
      };
    } | null;
    const start = new Date(now.getTime() - days * 86_400_000);
    const details: Array<{
      account: string;
      currency: string;
      response: unknown;
    }> = [];
    for (const account of overview?.content?.demandAccounts ?? []) {
      for (const detail of account.details ?? []) {
        if (!account.account || !detail.currencyCode) continue;
        details.push({
          account: account.account,
          currency: detail.currencyCode,
          response: await post("R_ACCT_Q_TransferDetail", {
            custID: jwt.customerId,
            account: account.account,
            currencyList: [detail.currencyCode],
            startDate: localDate(start),
            endDate: localDate(now),
          }),
        });
      }
    }
    return { overview, details };
  }, lookbackDays)) as CathayForeignPayloads | null;
  return raw;
}
