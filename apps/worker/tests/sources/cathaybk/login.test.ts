import { describe, expect, it, vi } from "vitest";
import {
  dismissCathaySystemMessageIfPresent,
  ensureCathayJQuery,
} from "../../../src/sources/cathaybk/connector";

describe("國泰登入公告", () => {
  it.each([[], ["我知道了"], ["下一則", "下一則", "我知道了"]])(
    "讀完公告後才繼續登入：%j",
    async (...labels: string[]) => {
      const buttons = labels.map((label) => ({
        click: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(label),
      }));
      let current = 0;
      const page = {
        $: vi.fn(async () => buttons[current++] ?? null),
        waitForSelector: vi.fn(async () => {
          if (current !== buttons.length) throw new Error("公告尚未讀完");
        }),
      };
      await expect(
        dismissCathaySystemMessageIfPresent(
          page as unknown as Parameters<
            typeof dismissCathaySystemMessageIfPresent
          >[0],
        ),
      ).resolves.toBe(buttons.length > 0);
      for (const button of buttons) expect(button.click).toHaveBeenCalledOnce();
      expect(page.waitForSelector).toHaveBeenCalledTimes(
        buttons.length ? 1 : 0,
      );
    },
  );

  it("不點擊未知公告動作，也不讓公告無限循環", async () => {
    for (const label of ["立即啟用", "下一則"]) {
      const button = {
        click: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(label),
      };
      const page = {
        $: vi.fn().mockResolvedValue(button),
        waitForSelector: vi.fn().mockResolvedValue(undefined),
      };
      await expect(dismissCathaySystemMessageIfPresent(page)).rejects.toThrow(
        label === "立即啟用"
          ? "Cathay system message action changed."
          : "Cathay system message list exceeded 20 notices.",
      );
      expect(button.click).toHaveBeenCalledTimes(label === "立即啟用" ? 0 : 20);
      expect(page.waitForSelector).not.toHaveBeenCalled();
    }
  });
});

describe("國泰登入頁 jQuery", () => {
  it("沿用已載入的 jQuery 並補上全域 $ alias", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(true);
    const page = {
      addScriptTag: vi.fn(),
      evaluate,
      waitForFunction: vi.fn(),
    };

    await expect(
      ensureCathayJQuery(
        page as unknown as Parameters<typeof ensureCathayJQuery>[0],
      ),
    ).resolves.toBeUndefined();
    expect(page.waitForFunction).not.toHaveBeenCalled();
    expect(page.addScriptTag).not.toHaveBeenCalled();
  });

  it("載入失敗時只重新載入銀行頁面宣告的同源 jQuery", async () => {
    const page = {
      addScriptTag: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(
          "https://www.cathaybk.com.tw/MyBank/Content/CUB/js/jQuery.js?v=1",
        )
        .mockResolvedValueOnce(true),
      waitForFunction: vi.fn().mockRejectedValue(new Error("timeout")),
    };

    await expect(
      ensureCathayJQuery(
        page as unknown as Parameters<typeof ensureCathayJQuery>[0],
      ),
    ).resolves.toBeUndefined();
    expect(page.addScriptTag).toHaveBeenCalledWith({
      url: "https://www.cathaybk.com.tw/MyBank/Content/CUB/js/jQuery.js?v=1",
    });
  });

  it("頁面沒有同源 jQuery 時停止登入", async () => {
    const page = {
      addScriptTag: vi.fn(),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(null),
      waitForFunction: vi.fn().mockRejectedValue(new Error("timeout")),
    };

    await expect(
      ensureCathayJQuery(
        page as unknown as Parameters<typeof ensureCathayJQuery>[0],
      ),
    ).rejects.toThrow("did not provide its jQuery script");
    expect(page.addScriptTag).not.toHaveBeenCalled();
  });
});
