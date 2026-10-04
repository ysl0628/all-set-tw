import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { launchBrowserWithRetry } from "../browser.js";

const HSBC_ORIGIN = "https://card.hsbc.com.tw";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const NAVIGATION_TIMEOUT_MS = 30_000;
const CAPTCHA_KEEP_ALIVE_MS = 3 * 60_000;

export type HsbcBrowserContext = {
  browser: Browser;
  page: Page;
  fetcher: typeof fetch;
};

/**
 * 匯豐前方的網路防護會拒絕 Worker 直接 fetch；所有 BFF 請求必須在真正的
 * Browser Rendering 頁面內送出，讓瀏覽器完成首頁載入與防護 Cookie 流程。
 */
export async function launchHsbcBrowser(
  binding: Fetcher,
): Promise<HsbcBrowserContext> {
  const browser = await launchBrowserWithRetry(binding, {
    keep_alive: CAPTCHA_KEEP_ALIVE_MS,
  });
  try {
    return await initializeContext(browser);
  } catch (error) {
    await closeHsbcBrowser(browser);
    throw error;
  }
}

export async function reconnectHsbcBrowser(
  binding: Fetcher,
  sessionId: string,
): Promise<HsbcBrowserContext> {
  const sessions = await puppeteer.sessions(binding).catch(() => []);
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    throw new Error("匯豐驗證碼工作階段已逾時，請重新取得驗證碼。");
  }
  if (session.connectionId) {
    throw new Error("匯豐驗證碼工作階段仍在使用中，請稍候再試。");
  }
  const browser = await puppeteer.connect(binding, sessionId);
  try {
    return await existingContext(browser);
  } catch (error) {
    await closeHsbcBrowser(browser);
    throw error;
  }
}

export async function closeHsbcBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "hsbc_browser_close_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

async function initializeContext(
  browser: Browser,
): Promise<HsbcBrowserContext> {
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await page.goto(`${HSBC_ORIGIN}/`, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
    { timeout: NAVIGATION_TIMEOUT_MS },
  );
  return {
    browser,
    page,
    fetcher: createHsbcBrowserFetch(page),
  };
}

async function existingContext(browser: Browser): Promise<HsbcBrowserContext> {
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  if (!page.url().startsWith(HSBC_ORIGIN)) {
    await page.goto(`${HSBC_ORIGIN}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }
  return {
    browser,
    page,
    fetcher: createHsbcBrowserFetch(page),
  };
}

/** 僅轉送固定匯豐 origin，且讓瀏覽器自行管理 Origin、Referer、Cookie 與 User-Agent。 */
export function createHsbcBrowserFetch(page: Page): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== HSBC_ORIGIN) {
      throw new Error("Blocked cross-origin HSBC browser request.");
    }
    const sourceHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const headers: Record<string, string> = {};
    for (const name of ["accept", "authorization", "content-type"]) {
      const value = sourceHeaders.get(name);
      if (value) headers[name] = value;
    }
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    const result = await page.evaluate(
      async ({ requestUrl, requestMethod, requestHeaders, requestBody }) => {
        const response = await fetch(requestUrl, {
          method: requestMethod,
          headers: requestHeaders,
          ...(requestBody === undefined ? {} : { body: requestBody }),
          credentials: "include",
          redirect: "manual",
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body: await response.text(),
        };
      },
      {
        requestUrl: url.toString(),
        requestMethod: method,
        requestHeaders: headers,
        requestBody: body,
      },
    );
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }) as typeof fetch;
}
