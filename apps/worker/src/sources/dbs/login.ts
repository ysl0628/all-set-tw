import {
  DbsApiError,
  dbsApiPath,
  dbsResponseInfo,
  type DbsCredentials,
  type DbsRequest,
  type DbsSession,
} from "./api";
import { encryptDbsPassword } from "./password";

const ORIGIN = "https://internet-banking.dbs.com.tw";
const KEY_INDEX = "CN2048";

/** 每個網銀請求共用的 header；值取自網銀前端（`channelId: DIB`、`clientId: web`）。 */
const COMMON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  channelId: "DIB",
  clientId: "web",
  region: "TW",
  locale: "zh",
  Origin: ORIGIN,
  Referer: `${ORIGIN}/digitw/`,
};

/** 帳號鎖定、暫停使用與重複登入的銀行代碼；其餘失敗一律視為登入未成功。 */
const LOCKED_CODES = new Set(["17", "98"]);
const DUPLICATE_SESSION_CODES = new Set(["9021"]);

type Fetch = typeof fetch;

/**
 * 網銀 1FA：取得亂數與公鑰、加密密碼後登入，再以 `commCode` 換取 access token。
 * 只嘗試一次，不重試、不呼叫簡訊 OTP；失敗時拋出 `DbsApiError`。
 */
export async function loginDbsWithFetch(
  credentials: DbsCredentials,
  fetcher: Fetch = fetch,
): Promise<DbsSession> {
  const cookies = new Map<string, string>();
  const send = async (path: string, init: RequestInit, operation: string) => {
    let response: Response;
    try {
      response = await fetcher(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          ...COMMON_HEADERS,
          ...(cookies.size
            ? {
                Cookie: [...cookies]
                  .map(([name, value]) => `${name}=${value}`)
                  .join("; "),
              }
            : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      throw new DbsApiError("connection", operation);
    }
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (pair && index > 0) {
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body: isRecord(body) ? body : {} };
  };

  const random = await send(
    "/iam/v2/random",
    { method: "POST", body: "{}" },
    "random",
  );
  const randomHex = stringField(random.body, "random");
  const preAuthId = stringField(random.body, "preAuthId");
  if (!random.response.ok || !randomHex || !preAuthId) {
    throw new DbsApiError(
      "protocol",
      "random",
      undefined,
      dbsResponseInfo(random.response),
    );
  }

  const key = await send(
    `/iam/v1/publickey/${KEY_INDEX}`,
    { method: "POST", body: "{}" },
    "publickey",
  );
  const modulus = stringField(key.body, "modulus");
  const exponent = stringField(key.body, "exponent");
  // 密碼加密固定使用 e = 65537。
  if (
    !key.response.ok ||
    !modulus ||
    exponent?.replace(/^0+/, "") !== "10001"
  ) {
    throw new DbsApiError(
      "protocol",
      "publickey",
      undefined,
      dbsResponseInfo(key.response),
    );
  }

  let encryptedPassword: string;
  try {
    encryptedPassword = encryptDbsPassword(
      credentials.password,
      randomHex,
      modulus,
    );
  } catch {
    throw new DbsApiError("credentials", "encrypt");
  }

  const auth = await send(
    "/iam/v2/realms/tw/authenticate?authIndexType=service&authIndexValue=1fa",
    {
      method: "POST",
      headers: {
        actionId: "LOGIN_1FA",
        privateKeyIndex: KEY_INDEX,
        "AM-Username": encodeURIComponent(credentials.account),
        "AM-ENC-Password": encryptedPassword,
        "AM-Random-Number": randomHex,
      },
      body: JSON.stringify({ authId: preAuthId }),
    },
    "authenticate",
  );
  const commCode = stringField(auth.body, "commCode");
  if (!commCode) throw authenticationError(auth.body, auth.response);

  const token = await send(
    `/iam/v1/oauth2/realms/tw/access_token?${new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:ciam-sso",
      oauth_client_id: "mb_digibank",
      comm_code: commCode,
    })}`,
    { method: "POST", headers: { actionId: "ACCESS_TOKEN" }, body: "{}" },
    "access_token",
  );
  const accessToken = stringField(token.body, "access_token");
  if (!token.response.ok || !accessToken) {
    throw new DbsApiError(
      "protocol",
      "access_token",
      undefined,
      dbsResponseInfo(token.response),
    );
  }
  let customerId =
    auth.response.headers.get("customerid") ??
    token.response.headers.get("customerid") ??
    undefined;

  return {
    async request(request: DbsRequest) {
      const result = await send(
        dbsApiPath(request.path),
        {
          method: request.method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            actionId: request.actionId,
            ...(request.version ? { "x-version": request.version } : {}),
            ...(customerId ? { customerId } : {}),
            correlationId: correlationId(),
            requestUUID: crypto.randomUUID(),
            requestDateTime: requestDateTime(),
            ...request.headers,
          },
          ...(request.body !== undefined
            ? { body: JSON.stringify(request.body) }
            : {}),
        },
        request.actionId,
      );
      customerId = result.response.headers.get("customerid") ?? customerId;
      if (result.response.status === 401 || result.response.status === 403) {
        throw new DbsApiError(
          "credentials",
          request.actionId,
          undefined,
          dbsResponseInfo(result.response),
        );
      }
      if (!result.response.ok) {
        throw new DbsApiError(
          "connection",
          request.actionId,
          undefined,
          dbsResponseInfo(result.response),
        );
      }
      return result.body;
    },
    async logout() {
      await send(
        "/iam/v1/realms/tw/sessions?_action=logout",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: "{}",
        },
        "logout",
      );
    },
  };
}

/** 只保留白名單銀行代碼，不保存銀行訊息原文。 */
function authenticationError(
  body: Record<string, unknown>,
  response: Response,
): DbsApiError {
  const info = dbsResponseInfo(response);
  const code = [body.code, body.responseCode, body.errorCode]
    .map((value) => (value == null ? "" : String(value)))
    .find(
      (value) => LOCKED_CODES.has(value) || DUPLICATE_SESSION_CODES.has(value),
    );
  if (code && LOCKED_CODES.has(code)) {
    return new DbsApiError("locked", "authenticate", code, info);
  }
  if (code && DUPLICATE_SESSION_CODES.has(code)) {
    return new DbsApiError("duplicate_session", "authenticate", code, info);
  }
  return new DbsApiError("credentials", "authenticate", undefined, info);
}

function stringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 網銀前端格式為 11 位數字。 */
function correlationId() {
  const digits = crypto.getRandomValues(new Uint8Array(11));
  return Array.from(digits, (digit, index) =>
    String(index === 0 ? (digit % 9) + 1 : digit % 10),
  ).join("");
}

/** 網銀前端格式為 UTC `yyyy-MM-ddTHH:mm:ss:SSS`。 */
function requestDateTime(now = new Date()) {
  const iso = now.toISOString();
  return `${iso.slice(0, 19)}:${iso.slice(20, 23)}`;
}
