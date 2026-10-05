import type { Page } from "@cloudflare/puppeteer";
import { DbsApiError } from "./api";

/** 網銀首頁；在此頁面內發出的請求為同源，cookie 由瀏覽器管理。 */
export const DBS_ENTRY_URL = "https://internet-banking.dbs.com.tw/digitw/";

/** 瀏覽器會自行處理、不允許由頁面腳本指定的 header。 */
const BROWSER_MANAGED_HEADERS = new Set(["cookie", "origin", "referer"]);

/**
 * 正式環境 Worker 直接連線會被星展以 403 擋下，改由 Browser Rendering 的頁面
 * 發出相同請求。回傳值與 `fetch` 相容，讓登入與資料讀取沿用同一份程式。
 */
export async function openDbsBrowserFetch(page: Page): Promise<typeof fetch> {
  const entry = await page.goto(DBS_ENTRY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  const status = entry?.status() ?? 0;
  if (status < 200 || status >= 400) {
    throw new DbsApiError("connection", "entry", undefined, {
      status,
      contentType: "other",
    });
  }

  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith("https://internet-banking.dbs.com.tw/")) {
      throw new DbsApiError("protocol", "browser_fetch_origin");
    }
    if (init.body != null && typeof init.body !== "string") {
      throw new DbsApiError("protocol", "browser_fetch_body");
    }
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).filter(
        ([name]) => !BROWSER_MANAGED_HEADERS.has(name.toLowerCase()),
      ),
    );
    const result = await page.evaluate(
      async (request: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | null;
      }) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          credentials: "include",
        });
        return {
          status: response.status,
          headers: [...response.headers.entries()],
          text: await response.text(),
        };
      },
      {
        url,
        method: init.method ?? "GET",
        headers,
        body: (init.body as string | undefined) ?? null,
      },
    );
    return new Response(
      result.status === 204 || result.status === 304 ? null : result.text,
      { status: result.status, headers: result.headers },
    );
  }) as typeof fetch;
}
