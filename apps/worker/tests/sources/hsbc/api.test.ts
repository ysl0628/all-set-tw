import { describe, expect, it } from "vitest";
import {
  HsbcApiClient,
  HsbcApiError,
  collectHsbcCardPayloads,
  decodeCaptchaImage,
} from "../../../src/sources/hsbc/api";
import {
  hsbcCard,
  hsbcCardDetail,
  hsbcPostedPage0,
  hsbcPostedPage1,
  hsbcStatements,
  hsbcUnposted,
} from "./fixtures/cards";

const PNG_BASE64 = btoa(
  String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2),
);

type Call = { url: string; init: RequestInit };

function json(payload: unknown, init: ResponseInit & { cookie?: string } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (init.cookie) headers.append("Set-Cookie", init.cookie);
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers,
  });
}

function fakeBank(
  handler: (path: string, call: Call) => Response | undefined = () => undefined,
) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { url, init: init ?? {} };
    calls.push(call);
    const path = new URL(url).pathname.replace("/ibk-bff/api/v1", "");
    const custom = handler(path, call);
    if (custom) return custom;
    if (path === "/authentication")
      return json({ success: true, payload: { exists: true }, error: null });
    if (path === "/captcha/request")
      return json(
        {
          success: true,
          payload: {
            captchaKey: "k".repeat(32),
            captchaImg: PNG_BASE64,
            captchaHash: "h",
          },
          error: null,
        },
        { cookie: "BFFSESSION=abc123; Path=/; HttpOnly" },
      );
    if (path === "/authentication/login")
      return json({
        success: true,
        payload: { accessToken: "jwt-token" },
        error: null,
      });
    if (path === "/session")
      return json({
        success: true,
        payload: { sessionId: "session-id" },
        error: null,
      });
    if (path === "/authentication/logout")
      return json({ success: true, payload: {}, error: null });
    if (path === "/cards")
      return json({ success: true, payload: [hsbcCard], error: null });
    if (path === `/cards/${hsbcCard.id}`)
      return json({ success: true, payload: hsbcCardDetail, error: null });
    if (path.endsWith("/view-statement"))
      return json({ success: true, payload: hsbcStatements, error: null });
    if (path.endsWith("/transactions/unposted"))
      return json({ success: true, payload: hsbcUnposted, error: null });
    if (path.endsWith("/transactions/posted")) {
      const page = Number(new URL(url).searchParams.get("pageNumber"));
      const content = [hsbcPostedPage0, hsbcPostedPage1, []][page] ?? [];
      return json({
        success: true,
        payload: {
          pageInfo: { currentPageIndex: page, isLast: false, totalPages: 27 },
          content,
        },
        error: null,
      });
    }
    return json(
      { success: false, payload: null, error: { message: "not found" } },
      { status: 404 },
    );
  }) as typeof fetch;
  return { calls, fetcher };
}

async function decryptField(base64: string, ivBase64: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("0123456789abcdef"),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const toBytes = (value: string) =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: toBytes(ivBase64) },
    key,
    toBytes(base64),
  );
  return new TextDecoder().decode(plain);
}

describe("匯豐信用卡 API client", () => {
  it("依官網流程登入：帳密以 AES-CBC 加密、帶上驗證碼 key，並沿用工作階段 cookie", async () => {
    const { calls, fetcher } = fakeBank();
    const client = new HsbcApiClient({ fetcher, now: () => 1_000 });
    const captcha = await client.prepareCaptcha("demo-user");
    expect(captcha).toMatchObject({
      key: "k".repeat(32),
      contentType: "image/png",
      cookies: "BFFSESSION=abc123",
      expiresAt: 1_000 + 120_000,
    });
    expect(captcha.dataUri.startsWith("data:image/png;base64,")).toBe(true);

    await client.login({
      account: "demo-user",
      password: "secret-pass",
      captchaKey: captcha.key,
      captcha: "Ab12Cd",
    });
    const login = calls.find((call) =>
      call.url.endsWith("/authentication/login"),
    )!;
    const body = JSON.parse(String(login.init.body)) as Record<string, string>;
    expect(body).toMatchObject({
      lastKey: "k".repeat(32),
      inputCode: "Ab12Cd",
      pushToken: "",
      language: "zh_tw",
    });
    expect(String(login.init.body)).not.toContain("secret-pass");
    expect(await decryptField(body.username!, body.iv!)).toBe("demo-user");
    expect(await decryptField(body.password!, body.iv!)).toBe("secret-pass");
    expect(new Headers(login.init.headers).get("Cookie")).toBe(
      "BFFSESSION=abc123",
    );

    const captchaRequest = calls.find((call) =>
      call.url.includes("/captcha/request?"),
    )!;
    expect(new URL(captchaRequest.url).searchParams.get("language")).toBe(
      "zh_tw",
    );

    const session = calls.find((call) => call.url.endsWith("/session"))!;
    expect(new Headers(session.init.headers).get("Authorization")).toBe(
      "Bearer jwt-token",
    );
    expect(calls.indexOf(session)).toBeGreaterThan(calls.indexOf(login));

    await client.listCards();
    const cards = calls.find((call) => call.url.endsWith("/api/v1/cards"))!;
    expect(new Headers(cards.init.headers).get("Authorization")).toBe(
      "Bearer jwt-token",
    );
  });

  it("還原保存的 cookie 後才能提交人工驗證碼", async () => {
    const { calls, fetcher } = fakeBank();
    const client = new HsbcApiClient({ fetcher });
    client.restoreCookies("BFFSESSION=saved;other=1");
    await client.login({
      account: "demo-user",
      password: "secret-pass",
      captchaKey: "key",
      captcha: "Ab12Cd",
    });
    expect(new Headers(calls[0]!.init.headers).get("Cookie")).toBe(
      "BFFSESSION=saved; other=1",
    );
  });

  it("把登入失敗分成驗證碼、帳密與額外驗證，錯誤訊息不含帳密", async () => {
    const cases: Array<[unknown, number, string]> = [
      [
        { success: false, error: { code: "E1", message: "圖形驗證碼錯誤" } },
        400,
        "captcha",
      ],
      [
        {
          success: false,
          error: { code: "E2", message: "使用者代號或密碼錯誤" },
        },
        400,
        "credentials",
      ],
      [{ success: true, payload: { otpRequired: true } }, 200, "otp_required"],
      [
        { success: false, error: { code: "E9", message: "系統忙碌" } },
        500,
        "protocol",
      ],
    ];
    for (const [payload, status, kind] of cases) {
      const { fetcher } = fakeBank((path) =>
        path === "/authentication/login"
          ? json(payload, { status })
          : undefined,
      );
      const error = await new HsbcApiClient({ fetcher })
        .login({
          account: "demo-user",
          password: "secret-pass",
          captchaKey: "key",
          captcha: "Ab12Cd",
        })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(HsbcApiError);
      expect((error as HsbcApiError).kind).toBe(kind);
      expect(String((error as Error).message)).not.toContain("secret-pass");
    }
  });

  it("只保留安全的銀行錯誤代碼，不帶入錯誤內容", async () => {
    const { fetcher } = fakeBank((path) =>
      path === "/authentication/login"
        ? json(
            {
              success: false,
              error: {
                errorCode: "LOGIN_5007",
                message: "unclassified private bank response",
              },
            },
            { status: 500 },
          )
        : undefined,
    );
    const error = await new HsbcApiClient({ fetcher })
      .login({
        account: "demo-user",
        password: "secret-pass",
        captchaKey: "key",
        captcha: "Ab12C",
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      kind: "protocol",
      operation: "login",
      status: 500,
      bankCode: "LOGIN_5007",
    });
    expect(JSON.stringify(error)).not.toContain("private bank response");
  });

  it("使用者代號不存在時不取驗證碼", async () => {
    const { calls, fetcher } = fakeBank((path) =>
      path === "/authentication"
        ? json({ success: true, payload: { exists: false }, error: null })
        : undefined,
    );
    await expect(
      new HsbcApiClient({ fetcher }).prepareCaptcha("nobody"),
    ).rejects.toMatchObject({ kind: "credentials" });
    expect(calls.some((call) => call.url.includes("/captcha/"))).toBe(false);
  });

  it("登入後 token 失效時回報 session_expired", async () => {
    const { fetcher } = fakeBank((path) =>
      path === "/cards" ? new Response("", { status: 401 }) : undefined,
    );
    const client = new HsbcApiClient({ fetcher });
    await client.login({
      account: "u",
      password: "p",
      captchaKey: "k",
      captcha: "Ab12Cd",
    });
    await expect(client.listCards()).rejects.toMatchObject({
      kind: "session_expired",
      operation: "list_cards",
      status: 401,
    });
  });

  it("授權錯誤只保留安全的操作名稱與狀態碼", async () => {
    const sensitiveCardId = "card-secret-identifier";
    const { fetcher } = fakeBank((path) =>
      path === `/cards/${sensitiveCardId}`
        ? new Response("", { status: 403 })
        : undefined,
    );
    const client = new HsbcApiClient({ fetcher });
    await client.login({
      account: "u",
      password: "p",
      captchaKey: "k",
      captcha: "Ab12Cd",
    });
    const error = await client
      .getCardDetail(sensitiveCardId)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      kind: "session_expired",
      operation: "card_detail",
      status: 403,
    });
    expect(String(error)).not.toContain(sensitiveCardId);
  });

  it("已出帳交易翻到早於回溯起日的頁面就停止，未出帳與帳單一併取得", async () => {
    const { calls, fetcher } = fakeBank();
    const client = new HsbcApiClient({ fetcher });
    await client.login({
      account: "u",
      password: "p",
      captchaKey: "k",
      captcha: "Ab12Cd",
    });
    const payloads = await collectHsbcCardPayloads(
      client,
      new Date("2026-10-03T04:00:00Z"),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.postedPages).toEqual([
      hsbcPostedPage0,
      hsbcPostedPage1,
      [],
    ]);
    expect(payloads[0]?.unposted).toEqual(hsbcUnposted);
    expect(payloads[0]?.statements).toEqual(hsbcStatements);
    const pages = calls
      .filter((call) => call.url.includes("/transactions/posted"))
      .map((call) => new URL(call.url).searchParams.get("pageNumber"));
    expect(pages).toEqual(["0", "1", "2"]);
  });

  it("銀行回傳的頁碼與請求不符時視為格式異常", async () => {
    const { fetcher } = fakeBank((path) =>
      path.endsWith("/transactions/posted")
        ? json({
            success: true,
            payload: { pageInfo: { currentPageIndex: 5 }, content: [] },
          })
        : undefined,
    );
    const client = new HsbcApiClient({ fetcher });
    await client.login({
      account: "u",
      password: "p",
      captchaKey: "k",
      captcha: "Ab12Cd",
    });
    await expect(collectHsbcCardPayloads(client)).rejects.toMatchObject({
      kind: "protocol",
    });
  });
});

describe("匯豐驗證碼圖片", () => {
  it("接受 data URI 與純 base64，無法辨識的格式視為異常", () => {
    expect(decodeCaptchaImage(PNG_BASE64).contentType).toBe("image/png");
    expect(
      decodeCaptchaImage(`data:image/jpeg;base64,${PNG_BASE64}`).contentType,
    ).toBe("image/jpeg");
    expect(() => decodeCaptchaImage(btoa("plain text"))).toThrow(HsbcApiError);
  });
});
