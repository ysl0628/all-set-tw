import { describe, expect, it } from "vitest";
import { DbsApiError } from "../../../src/sources/dbs/api";
import { loginDbsWithFetch } from "../../../src/sources/dbs/login";

// 帳密、亂數、公鑰與 token 皆為合成值。
const credentials = { account: "user name", password: "pass1234" };
const MODULUS = "ff".repeat(256);

type Call = { url: string; init: RequestInit };

function fakeFetch(authenticateBody: Record<string, unknown>) {
  const calls: Call[] = [];
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/iam/v2/random")) {
      return json({ random: "0011223344556677", preAuthId: "PRE-AUTH" });
    }
    if (url.includes("/iam/v1/publickey/CN2048")) {
      return json({ modulus: MODULUS, exponent: "010001" });
    }
    if (url.includes("/authenticate")) return json(authenticateBody);
    if (url.includes("/access_token")) {
      return json(
        { token_type: "Bearer", access_token: "ACCESS", expires_in: "1799" },
        { headers: { customerid: "CUST" } },
      );
    }
    if (url.includes("_action=logout")) return json({ result: "Success" });
    return json({ ok: true });
  }) as typeof fetch;
  return { calls, fetcher };
}

function headers(call: Call | undefined) {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

describe("星展登入", () => {
  it("1FA 送出的 header 與 body 名稱固定，並以 commCode 換 token", async () => {
    const { calls, fetcher } = fakeFetch({ commCode: "COMM" });
    const session = await loginDbsWithFetch(credentials, fetcher);

    const auth = calls.find((call) => call.url.includes("/authenticate"));
    expect(auth?.url).toBe(
      "https://internet-banking.dbs.com.tw/iam/v2/realms/tw/authenticate?authIndexType=service&authIndexValue=1fa",
    );
    expect(JSON.parse(String(auth?.init.body))).toEqual({
      authId: "PRE-AUTH",
    });
    const authHeaders = headers(auth);
    expect(authHeaders).toMatchObject({
      actionId: "LOGIN_1FA",
      privateKeyIndex: "CN2048",
      "AM-Username": "user%20name",
      "AM-Random-Number": "0011223344556677",
    });
    expect(authHeaders["AM-ENC-Password"]).toMatch(/^[0-9a-f]{512}$/);
    // 明碼密碼不得出現在任何請求中。
    expect(JSON.stringify(calls)).not.toContain("pass1234");

    const token = calls.find((call) => call.url.includes("/access_token"));
    expect(new URL(token!.url).searchParams.get("comm_code")).toBe("COMM");
    expect(headers(token).actionId).toBe("ACCESS_TOKEN");

    await session.request({
      method: "GET",
      path: "/dashboard/channels/customerFinancialOverview/assets",
      actionId: "DASHBOARD-ASSET",
      version: "3.0.0",
    });
    const data = calls.at(-1);
    expect(data?.url).toBe(
      "https://internet-banking.dbs.com.tw/prd/api/tw/v1/dashboard/channels/customerFinancialOverview/assets",
    );
    expect(headers(data)).toMatchObject({
      Authorization: "Bearer ACCESS",
      actionId: "DASHBOARD-ASSET",
      "x-version": "3.0.0",
      customerId: "CUST",
      channelId: "DIB",
      clientId: "web",
      region: "TW",
    });

    await session.logout();
    expect(calls.at(-1)?.url).toContain(
      "/iam/v1/realms/tw/sessions?_action=logout",
    );
    // 不呼叫簡訊 OTP。
    expect(calls.some((call) => /otp/i.test(call.url))).toBe(false);
  });

  it("沒有 commCode 時只嘗試一次，依白名單代碼回報", async () => {
    for (const [body, kind] of [
      [{ code: "17" }, "locked"],
      [{ responseCode: "9021" }, "duplicate_session"],
      [{ code: "401", reason: "銀行訊息原文" }, "credentials"],
    ] as const) {
      const { calls, fetcher } = fakeFetch(body);
      const error = await loginDbsWithFetch(credentials, fetcher).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DbsApiError);
      expect((error as DbsApiError).kind).toBe(kind);
      expect((error as DbsApiError).message).not.toContain("銀行訊息原文");
      expect(
        calls.filter((call) => call.url.includes("/authenticate")),
      ).toHaveLength(1);
      expect(calls.some((call) => call.url.includes("/access_token"))).toBe(
        false,
      );
    }
  });
});
