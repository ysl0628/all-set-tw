import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@cloudflare/puppeteer";
import { DbsApiError } from "../../../src/sources/dbs/api";
import { openDbsBrowserFetch } from "../../../src/sources/dbs/browser";

// 以 Node 的 fetch stub 模擬頁面內的 fetch；網址與內容為合成值。
function fakePage(entryStatus: number) {
  return {
    goto: vi.fn(async () => ({ status: () => entryStatus })),
    evaluate: vi.fn(
      async (fn: (arg: unknown) => Promise<unknown>, arg: unknown) => fn(arg),
    ),
  } as unknown as Page;
}

afterEach(() => vi.unstubAllGlobals());

describe("星展 Browser Rendering 連線", () => {
  it("在網銀頁面內送出請求，交由瀏覽器管理 cookie 與來源 header", async () => {
    const pageFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ random: "00" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", pageFetch);
    const fetcher = await openDbsBrowserFetch(fakePage(200));
    const response = await fetcher(
      "https://internet-banking.dbs.com.tw/iam/v2/random",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "a=b",
          Origin: "https://internet-banking.dbs.com.tw",
          Referer: "https://internet-banking.dbs.com.tw/digitw/",
        },
        body: "{}",
      },
    );
    expect(await response.json()).toEqual({ random: "00" });
    expect(pageFetch).toHaveBeenCalledWith(
      "https://internet-banking.dbs.com.tw/iam/v2/random",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "include",
      },
    );
  });

  it("只允許星展網銀網域", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const fetcher = await openDbsBrowserFetch(fakePage(200));
    await expect(fetcher("https://example.com/")).rejects.toBeInstanceOf(
      DbsApiError,
    );
  });

  it("網銀首頁被擋時以連線失敗回報並帶 HTTP 狀態", async () => {
    const error = await openDbsBrowserFetch(fakePage(403)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DbsApiError);
    expect(error).toMatchObject({
      kind: "connection",
      operation: "entry",
      response: { status: 403 },
    });
  });
});
