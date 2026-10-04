import { postedPageReachedCutoff, syncCutoffDate } from "./protocol";
import type { HsbcCardPayloads } from "./protocol";

// Observed in the official card web bundle (card.hsbc.com.tw) on 2026-10-03.
// This is an internal web BFF, not a published developer API.
const ORIGIN = "https://card.hsbc.com.tw";
const BASE = "/ibk-bff/api/v1";
// The web client encrypts credentials with this fixed AES-128-CBC key before
// posting them over TLS; it is part of the public bundle, not a secret.
const LOGIN_AES_KEY = "0123456789abcdef";
const LANGUAGE = "zh-TW";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const HSBC_CAPTCHA_TTL_MS = 2 * 60_000;
const MAX_POSTED_PAGES = 40;
const MAX_CARDS = 10;

export type HsbcErrorKind =
  | "credentials"
  | "captcha"
  | "otp_required"
  | "session_expired"
  | "rate_limit"
  | "transport"
  | "protocol";

export class HsbcApiError extends Error {
  constructor(public readonly kind: HsbcErrorKind) {
    super(`匯豐信用卡 API：${kind}`);
    this.name = "HsbcApiError";
  }
}

export type HsbcCaptcha = {
  key: string;
  imageBytes: ArrayBuffer;
  contentType: string;
  /** 可直接顯示在 <img> 的 data URI。 */
  dataUri: string;
  cookies: string;
  expiresAt: number;
};

type JsonRecord = Record<string, unknown>;

/** Implements the observed login and read-only card queries.
 * The caller must keep CAPTCHA state, cookies and tokens out of logs and plaintext storage.
 */
export class HsbcApiClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cookies = new Map<string, string>();
  private accessToken?: string;

  constructor(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /** 還原手動驗證時保存的工作階段 cookie；只應來自加密且有版本保護的設定。 */
  restoreCookies(serialized: string | undefined) {
    this.cookies.clear();
    for (const part of (serialized ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(part.slice(0, index).trim(), part.slice(index + 1));
    }
  }

  serializeCookies(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join(";");
  }

  /** 先確認使用者代號存在，再取得一張新的圖形驗證碼。 */
  async prepareCaptcha(account: string): Promise<HsbcCaptcha> {
    const exists = await this.request("POST", "/authentication", {
      userId: account,
    });
    if (!isRecord(exists) || exists.exists !== true) {
      throw new HsbcApiError("credentials");
    }
    const data = await this.request(
      "POST",
      `/captcha/request?language=${encodeURIComponent(LANGUAGE)}`,
    );
    if (!isRecord(data)) throw new HsbcApiError("protocol");
    const key = nonempty(data.captchaKey);
    const image = decodeCaptchaImage(nonempty(data.captchaImg));
    return {
      key,
      ...image,
      cookies: this.serializeCookies(),
      expiresAt: this.now() + HSBC_CAPTCHA_TTL_MS,
    };
  }

  /** 提交帳密與驗證碼。驗證碼不論成功與否都只能使用一次，失敗時不可重送同一組。 */
  async login(credentials: {
    account: string;
    password: string;
    captchaKey: string;
    captcha: string;
  }): Promise<void> {
    const { account, password, captchaKey, captcha } = credentials;
    if (!account || !password) throw new HsbcApiError("credentials");
    if (!/^[A-Za-z0-9]{3,8}$/.test(captcha) || !captchaKey) {
      throw new HsbcApiError("captcha");
    }
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const data = await this.request(
      "POST",
      "/authentication/login",
      {
        username: await encryptLoginField(account, iv),
        password: await encryptLoginField(password, iv),
        iv: bytesToBase64(iv),
        deviceName: USER_AGENT,
        pushToken: "",
        language: LANGUAGE,
        lastKey: captchaKey,
        inputCode: captcha,
      },
      { login: true },
    );
    if (
      !isRecord(data) ||
      typeof data.accessToken !== "string" ||
      !data.accessToken
    ) {
      // 沒有發 token 的成功回應代表銀行要求額外驗證（例如簡訊 OTP）。
      throw new HsbcApiError("otp_required");
    }
    this.accessToken = data.accessToken.startsWith("Bearer ")
      ? data.accessToken
      : `Bearer ${data.accessToken}`;
  }

  async logout(): Promise<void> {
    if (!this.accessToken) return;
    try {
      await this.request("POST", "/authentication/logout");
    } finally {
      this.accessToken = undefined;
    }
  }

  async listCards(): Promise<JsonRecord[]> {
    const data = await this.authorized("/cards");
    if (!Array.isArray(data) || data.length > MAX_CARDS) {
      throw new HsbcApiError("protocol");
    }
    return data.map((card) => {
      if (!isRecord(card)) throw new HsbcApiError("protocol");
      return card;
    });
  }

  async getCardDetail(cardId: string): Promise<unknown> {
    return this.authorized(`/cards/${encodeURIComponent(cardId)}`);
  }

  async getStatements(cardId: string): Promise<unknown> {
    return this.authorized(
      `/cards/${encodeURIComponent(cardId)}/view-statement`,
    );
  }

  async getUnpostedTransactions(cardId: string): Promise<unknown> {
    return this.authorized(
      `/cards/${encodeURIComponent(cardId)}/transactions/unposted`,
    );
  }

  async getPostedTransactions(
    cardId: string,
    pageNumber: number,
  ): Promise<{ content: unknown[]; isLast: boolean }> {
    if (!Number.isInteger(pageNumber) || pageNumber < 0) {
      throw new HsbcApiError("protocol");
    }
    const data = await this.authorized(
      `/cards/${encodeURIComponent(cardId)}/transactions/posted?pageNumber=${pageNumber}`,
    );
    if (!isRecord(data) || !Array.isArray(data.content)) {
      throw new HsbcApiError("protocol");
    }
    const info = isRecord(data.pageInfo) ? data.pageInfo : {};
    const currentPage = info.currentPageIndex;
    if (currentPage !== undefined && currentPage !== pageNumber) {
      throw new HsbcApiError("protocol");
    }
    return {
      content: data.content,
      isLast: info.isLast === true || data.content.length === 0,
    };
  }

  private async authorized(path: string): Promise<unknown> {
    if (!this.accessToken) throw new HsbcApiError("session_expired");
    return this.request("GET", path);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: JsonRecord,
    options: { login?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": USER_AGENT,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    };
    if (body !== undefined || method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    if (this.accessToken) headers.Authorization = this.accessToken;
    const cookie = this.serializeCookies().replaceAll(";", "; ");
    if (cookie) headers.Cookie = cookie;
    let response: Response;
    try {
      response = await this.fetcher(`${ORIGIN}${BASE}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Never propagate request bodies, bank messages, cookies or tokens.
      throw new HsbcApiError("transport");
    }
    this.storeCookies(response);
    if (response.status === 429) throw new HsbcApiError("rate_limit");
    if (response.status === 401 || response.status === 403) {
      throw new HsbcApiError(options.login ? "credentials" : "session_expired");
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new HsbcApiError(response.ok ? "protocol" : "transport");
    }
    if (!isRecord(envelope)) throw new HsbcApiError("protocol");
    if (envelope.success === true) return envelope.payload;
    if (envelope.success === false || !response.ok) {
      throw new HsbcApiError(
        options.login ? loginErrorKind(envelope.error) : "protocol",
      );
    }
    throw new HsbcApiError("protocol");
  }

  private storeCookies(response: Response) {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (response.headers.get("set-cookie") ?? "")
            .split(/,(?=\s*[^;,=\s]+=)/)
            .filter(Boolean);
    for (const value of values) {
      const pair = value.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const cookieValue = pair.slice(index + 1).trim();
      if (!cookieValue || /max-age=0|expires=thu, 01 jan 1970/i.test(value)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
  }
}

/** 登入成功後，在任何資料寫入前取得一份完整、有上限的唯讀快照。 */
export async function collectHsbcCardPayloads(
  client: HsbcApiClient,
  now = new Date(),
): Promise<HsbcCardPayloads[]> {
  const cutoff = syncCutoffDate(now);
  const results: HsbcCardPayloads[] = [];
  for (const card of await client.listCards()) {
    const cardId =
      typeof card.id === "number" ? String(card.id) : nonempty(card.id);
    const postedPages: unknown[] = [];
    for (let page = 0; ; page += 1) {
      if (page >= MAX_POSTED_PAGES) throw new HsbcApiError("protocol");
      const { content, isLast } = await client.getPostedTransactions(
        cardId,
        page,
      );
      postedPages.push(content);
      if (isLast || postedPageReachedCutoff(content, cutoff)) break;
    }
    results.push({
      card,
      detail: await client.getCardDetail(cardId),
      statements: await client.getStatements(cardId),
      unposted: await client.getUnpostedTransactions(cardId),
      postedPages,
    });
  }
  return results;
}

function loginErrorKind(error: unknown): HsbcErrorKind {
  const record = isRecord(error) ? error : {};
  const text = [
    record.code,
    record.errorCode,
    record.message,
    record.errorMessage,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/驗證碼|captcha|圖形|inputCode/i.test(text)) return "captcha";
  if (/otp|簡訊|一次性/i.test(text)) return "otp_required";
  if (/密碼|帳號|代號|password|user(name)?|locked|鎖定|停用/i.test(text)) {
    return "credentials";
  }
  return "protocol";
}

async function encryptLoginField(value: string, iv: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(LOGIN_AES_KEY),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    new TextEncoder().encode(value),
  );
  return bytesToBase64(new Uint8Array(cipher));
}

/** 驗證碼圖片可能是 data URI 或純 base64；純 base64 依檔頭判斷格式。 */
export function decodeCaptchaImage(value: string): {
  imageBytes: ArrayBuffer;
  contentType: string;
  dataUri: string;
} {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(value.trim());
  const base64 = (match?.[2] ?? value).replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    throw new HsbcApiError("protocol");
  }
  if (bytes.length === 0) throw new HsbcApiError("protocol");
  const contentType = (match?.[1] ?? sniffImageType(bytes)).toLowerCase();
  return {
    imageBytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    contentType,
    dataUri: `data:${contentType};base64,${base64}`,
  };
}

function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "image/webp";
  }
  throw new HsbcApiError("protocol");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HsbcApiError("protocol");
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
