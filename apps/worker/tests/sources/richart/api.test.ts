import { describe, expect, it } from "vitest";
import {
  RichartApiClient,
  RichartApiError,
  richartErrorKind,
} from "../../../src/sources/richart/api";

const JPEG_BASE64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16));

type Call = { url: string; body: Record<string, unknown>; cookie: string };

/** 模擬伺服器：先發 JSESSIONID，並回傳合成的 E2EInit 公鑰。 */
async function fakeBank(
  overrides: Record<string, () => Record<string, unknown>> = {},
) {
  const server = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const serverPublicKey = Buffer.from(
    (await crypto.subtle.exportKey("raw", server.publicKey)) as ArrayBuffer,
  ).toString("hex");
  const calls: Call[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : {},
      cookie: headers.get("cookie") ?? "",
    });
    const path = url.replace(/^.*TSDIB_RWB_restful/, "");
    const responses: Record<string, () => Record<string, unknown>> = {
      "/SecurityCodeService/getSecurityCode": () => ({
        stat: "ok",
        result: {
          image: `data:image/png;base64,${JPEG_BASE64}`,
          fakeSessionId: "CMPLogin_synthetic",
        },
      }),
      "/E2EService/NoSecurity/E2EInit": () => ({
        stat: "ok",
        result: { serverPublicKey, sessionId: "e2e-session" },
      }),
      "/AuthService/isRepeated": () => ({
        stat: "ok",
        result: { isRepeated: false },
      }),
      "/AuthService/login": () => ({ stat: "ok", result: {} }),
      ...overrides,
    };
    const respond = responses[path];
    if (!respond) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(respond()), {
      headers: {
        "content-type": "application/json",
        ...(path === "/SecurityCodeService/getSecurityCode"
          ? { "set-cookie": "JSESSIONID=synthetic; Path=/; HttpOnly" }
          : {}),
      },
    });
  };
  return { calls, fetcher };
}

const credentials = {
  identity: "a123456789",
  userName: "demo1234",
  password: "pass5678",
};

describe("Richart API client", () => {
  it("依官方順序登入，沿用檢核碼 session，且不送出明文帳密", async () => {
    const bank = await fakeBank();
    const client = new RichartApiClient({ fetcher: bank.fetcher });
    const captcha = await client.prepareCaptcha();
    expect(captcha.contentType).toBe("image/jpeg");
    expect(captcha.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    await client.login(credentials, {
      securityCodeSessionId: captcha.securityCodeSessionId,
      securityCode: "1234",
    });
    expect(bank.calls.map((call) => call.url.split("/").slice(-1)[0])).toEqual([
      "getSecurityCode",
      "E2EInit",
      "isRepeated",
      "login",
    ]);
    const login = bank.calls[3]!;
    expect(login.cookie).toContain("JSESSIONID=synthetic");
    expect(login.body).toMatchObject({
      pid: "A123456789",
      sessionId: "e2e-session",
      securityCodeSessionId: "CMPLogin_synthetic",
      securityCode: "1234",
    });
    expect(login.body.userName).toMatch(/^[0-9a-f]{32}$/);
    expect(login.body.password).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(bank.calls)).not.toContain("pass5678");
    expect(JSON.stringify(bank.calls)).not.toContain("demo1234");
  });

  it("帳號已在其他地方登入時停止，不強制登出對方", async () => {
    const bank = await fakeBank({
      "/AuthService/isRepeated": () => ({
        stat: "ok",
        result: { isRepeated: true },
      }),
    });
    const client = new RichartApiClient({ fetcher: bank.fetcher });
    await expect(
      client.login(credentials, {
        securityCodeSessionId: "CMPLogin_synthetic",
        securityCode: "1234",
      }),
    ).rejects.toMatchObject({ kind: "session_conflict" });
    expect(bank.calls.some((call) => call.url.endsWith("/login"))).toBe(false);
  });

  it("帳密錯誤代碼不當成檢核碼錯誤，避免重試累積錯誤次數", async () => {
    const bank = await fakeBank({
      "/AuthService/isRepeated": () => ({
        stat: "error",
        errorCode: "AUTH08027",
        errorMsg: "synthetic",
      }),
    });
    const error = await new RichartApiClient({ fetcher: bank.fetcher })
      .login(credentials, {
        securityCodeSessionId: "CMPLogin_synthetic",
        securityCode: "1234",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RichartApiError);
    expect(error).toMatchObject({ kind: "credentials", bankCode: "AUTH08027" });
    expect(String((error as Error).message)).not.toContain("synthetic");
  });

  it("依官方登入元件分類錯誤", () => {
    expect(richartErrorKind("AUTH08026", "", true)).toBe("credentials");
    expect(richartErrorKind("X", "檢核碼錯誤，請重新輸入", true)).toBe(
      "captcha",
    );
    expect(richartErrorKind("AUTH08001", "", false)).toBe("session_expired");
    expect(richartErrorKind("USER01026", "", true)).toBe("account_unavailable");
    expect(richartErrorKind("SYS0099", "", false)).toBe("maintenance");
  });
});
