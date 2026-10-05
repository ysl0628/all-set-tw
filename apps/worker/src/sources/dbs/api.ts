import { BANK_SYNC_MONTHS } from "../sync-window";
import {
  dbsNextCursor,
  dbsTransactionTargets,
  type DbsPayloads,
} from "./protocol";

const API_BASE = "/prd/api/tw/v1";
/** 每個月份最多讀取的分頁數；超過時視為回應異常，不寫入部分資料。 */
const MAX_PAGES_PER_MONTH = 20;
const COUNT_PER_PAGE = 20;

export type DbsErrorKind =
  | "not_implemented"
  | "credentials"
  | "locked"
  | "duplicate_session"
  | "connection"
  | "protocol";

export class DbsApiError extends Error {
  constructor(
    readonly kind: DbsErrorKind,
    readonly operation?: string,
    /** 僅保存白名單內的銀行錯誤代碼，不保存銀行訊息原文。 */
    readonly bankCode?: string,
  ) {
    super(`星展 API：${kind}`);
    this.name = "DbsApiError";
  }
}

export type DbsCredentials = { account: string; password: string };

export type DbsRequest = {
  method: "GET" | "POST";
  /** `API_BASE` 之後的路徑。 */
  path: string;
  /** 網銀前端送出的 `actionId` header。 */
  actionId: string;
  /** 網銀前端送出的 `x-version` header；部分 API 沒有。 */
  version?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

/**
 * 已登入的網銀 session。實作負責登入時取得的 bearer token、cookie
 * 與每個請求共用的 header（region、locale、requestDateTime 等）。
 */
export interface DbsSession {
  request(request: DbsRequest): Promise<unknown>;
  logout(): Promise<void>;
}

/**
 * 以帳密完成網銀 1FA 登入並回傳 session。登入失敗時拋出 `DbsApiError`，
 * 不得重試、不得觸發簡訊 OTP。
 */
export type DbsLogin = (credentials: DbsCredentials) => Promise<DbsSession>;

/** 登入流程尚未實作；同步會回報連線失敗而不寫入任何資料。 */
export const loginDbs: DbsLogin = async () => {
  throw new DbsApiError("not_implemented", "login");
};

/** 登入後在任何資料寫入前，取得一份完整、有上限的唯讀快照。 */
export async function collectDbsPayloads(
  session: DbsSession,
  now = new Date(),
): Promise<DbsPayloads> {
  const assets = await session.request({
    method: "GET",
    path: "/dashboard/channels/customerFinancialOverview/assets",
    actionId: "DASHBOARD-ASSET",
    version: "3.0.0",
  });
  const liabilities = await session.request({
    method: "GET",
    path: "/dashboard/channels/customerFinancialOverview/liabilities",
    actionId: "DASHBOARD-LIABILITY",
    version: "3.0.0",
  });
  const transactions: DbsPayloads["transactions"] = [];
  for (const target of dbsTransactionTargets(assets)) {
    const pages: unknown[] = [];
    for (const window of dbsMonthWindows(now)) {
      let cursor: string | number = 0;
      for (let index = 0; ; index += 1) {
        if (index >= MAX_PAGES_PER_MONTH) {
          throw new DbsApiError("protocol", "transactions");
        }
        const page = await session.request({
          method: "POST",
          path: "/deposit-accounts-transactions-service/banking/deposit-accounts/transactions-history/inquiry",
          actionId: "DEPOSIT-TXN-HISTORY",
          version: "1.2.0",
          ...(window.isCurrentMonth
            ? { headers: { isCurrentMonthHeader: "true" } }
            : {}),
          body: {
            fromDate: {
              value: window.from,
              format: "yyyy-MM-dd'T'HH:mm:ssZ",
            },
            toDate: { value: window.to, format: "yyyy-MM-dd'T'HH:mm:ssZ" },
            countPerPage: COUNT_PER_PAGE,
            cursorId: cursor,
            isCurrentMonth: window.isCurrentMonth,
            globalAccountId: target.globalAccountId,
            currencyWallet: target.currency,
            previouscursor: "",
            cursorID: cursor,
          },
        });
        pages.push(page);
        const next = dbsNextCursor(page);
        if (next === null) break;
        cursor = next;
      }
    }
    transactions.push({ globalAccountId: target.globalAccountId, pages });
  }
  return { assets, liabilities, transactions };
}

export function dbsApiPath(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * 網銀明細一次查一個月：當月到現在（`isCurrentMonth`），其餘為整月。
 * 時間以臺灣時區（`+0800`）表示。
 */
export function dbsMonthWindows(now: Date): Array<{
  from: string;
  to: string;
  isCurrentMonth: boolean;
}> {
  const taiwan = new Date(now.getTime() + 8 * 3600_000);
  const year = taiwan.getUTCFullYear();
  const month = taiwan.getUTCMonth();
  const windows = [];
  for (let offset = 0; offset < BANK_SYNC_MONTHS; offset += 1) {
    const start = new Date(Date.UTC(year, month - offset, 1));
    const end = new Date(Date.UTC(year, month - offset + 1, 0));
    windows.push({
      from: `${start.toISOString().slice(0, 10)}T00:00:00+0800`,
      to:
        offset === 0
          ? `${taiwan.toISOString().slice(0, 19)}+0800`
          : `${end.toISOString().slice(0, 10)}T23:59:59+0800`,
      isCurrentMonth: offset === 0,
    });
  }
  return windows;
}
