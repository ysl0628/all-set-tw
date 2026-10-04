import type { Page } from "@cloudflare/puppeteer";
import { describe, expect, it, vi } from "vitest";
import { createHsbcBrowserFetch } from "../../../src/sources/hsbc/browser";

describe("匯豐 Browser Rendering transport", () => {
  it("只把安全的 API headers 傳入同源頁面，Cookie 與瀏覽器 headers 交給頁面管理", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      body: '{"success":true}',
    });
    const fetcher = createHsbcBrowserFetch({ evaluate } as unknown as Page);

    const response = await fetcher(
      "https://card.hsbc.com.tw/ibk-bff/api/v1/cards",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer test-token",
          Cookie: "private-cookie=1",
          Origin: "https://card.hsbc.com.tw",
          Referer: "https://card.hsbc.com.tw/",
          "User-Agent": "spoofed-agent",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(evaluate).toHaveBeenCalledOnce();
    const request = evaluate.mock.calls[0]![1] as {
      requestHeaders: Record<string, string>;
    };
    expect(request.requestHeaders).toEqual({
      accept: "application/json",
      authorization: "Bearer test-token",
    });
  });

  it("拒絕把瀏覽器工作階段拿去呼叫其他 origin", async () => {
    const evaluate = vi.fn();
    const fetcher = createHsbcBrowserFetch({ evaluate } as unknown as Page);
    await expect(fetcher("https://example.com/private")).rejects.toThrow(
      "Blocked cross-origin",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});
