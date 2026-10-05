import { BANK_SYNC_MONTHS } from "../sync-window";
import { createRichartE2eeKeyPair, richartE2eeEncrypt } from "./e2ee";

// 依 2026-10-04 公開的 Richart 網銀（richart.tw/WebBank）Angular bundle 整理；
// 這是網銀內部 API，不是公開的開發者 API。所有查詢皆為唯讀。
const ORIGIN = "https://richart.tw";
const API_ROOT = `${ORIGIN}/TSDIB_RWB_restful`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
/** 待人工輸入的檢核碼與其 session cookie 只短暫保存。 */
export const RICHART_CAPTCHA_TTL_MS = 2 * 60_000;
/** 檢核碼位數由銀行每次動態決定，實際看過 4 碼與 5 碼。 */
export const RICHART_CAPTCHA_LENGTH = { min: 4, max: 5 } as const;
export const RICHART_CAPTCHA_PATTERN = new RegExp(
  `^\\d{${RICHART_CAPTCHA_LENGTH.min},${RICHART_CAPTCHA_LENGTH.max}}$`,
);

export type RichartErrorKind =
  | "credentials"
  | "captcha"
  | "session_conflict"
  | "session_expired"
  | "account_unavailable"
  | "maintenance"
  | "transport"
  | "protocol";

export class RichartApiError extends Error {
  constructor(
    readonly kind: RichartErrorKind,
    readonly operation?: string,
    /** 僅保存銀行錯誤代碼（如 `AUTH08026`），不保存銀行訊息原文。 */
    readonly bankCode?: string,
  ) {
    super(`Richart API：${kind}`);
    this.name = "RichartApiError";
  }
}

export type RichartCaptcha = {
  securityCodeSessionId: string;
  imageBytes: ArrayBuffer;
  contentType: "image/jpeg" | "image/png";
  dataUri: string;
  expiresAt: number;
};

export type RichartCredentials = {
  /** 身分證字號。 */
  identity: string;
  /** Richart 使用者代號。 */
  userName: string;
  password: string;
};

type JsonRecord = Record<string, unknown>;
type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class RichartApiClient {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly cookies: Map<string, string>;

  constructor(
    options: {
      fetcher?: Fetcher;
      now?: () => number;
      cookies?: Record<string, string>;
    } = {},
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.cookies = new Map(Object.entries(options.cookies ?? {}));
  }

  /** 人工檢核碼流程需保留同一個 JSESSIONID；呼叫端必須加密保存並設定 TTL。 */
  exportCookies(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  async prepareCaptcha(): Promise<RichartCaptcha> {
    const result = await this.post(
      "/SecurityCodeService/getSecurityCode",
      {},
      "captcha",
    );
    const image = nonempty(result.image, "captcha");
    const securityCodeSessionId = nonempty(result.fakeSessionId, "captcha");
    const base64 = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(
      image,
    )?.[1];
    if (!base64) throw new RichartApiError("protocol", "captcha");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    // 銀行標示為 PNG，但實際回傳 JPEG；依檔頭判斷，避免 OCR 拒收。
    const contentType =
      bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
    return {
      securityCodeSessionId,
      imageBytes: bytes.buffer,
      contentType,
      dataUri: `data:${contentType};base64,${base64}`,
      expiresAt: this.now() + RICHART_CAPTCHA_TTL_MS,
    };
  }

  /**
   * 依官方網銀順序：E2EInit → isRepeated → login。
   * 若帳號已在其他地方登入，停止而不強制登出對方。
   */
  async login(
    credentials: RichartCredentials,
    captcha: { securityCodeSessionId: string; securityCode: string },
  ): Promise<void> {
    const { identity, userName, password } = credentials;
    if (
      !/^[A-Z][A-Z0-9]\d{8}$/i.test(identity) ||
      !/^[A-Za-z0-9]{6,16}$/.test(userName) ||
      !/^[A-Za-z0-9]{6,16}$/.test(password)
    ) {
      throw new RichartApiError("credentials", "login");
    }
    if (!RICHART_CAPTCHA_PATTERN.test(captcha.securityCode)) {
      throw new RichartApiError("captcha", "login");
    }
    const keyPair = await createRichartE2eeKeyPair();
    const init = await this.post(
      "/E2EService/NoSecurity/E2EInit",
      { clientPublicKey: keyPair.publicKeyHex },
      "e2e_init",
    );
    const serverPublicKey = nonempty(init.serverPublicKey, "e2e_init");
    const sessionId = nonempty(init.sessionId, "e2e_init");
    let encodedUser: Awaited<ReturnType<typeof richartE2eeEncrypt>>;
    let encodedPassword: Awaited<ReturnType<typeof richartE2eeEncrypt>>;
    try {
      encodedUser = await richartE2eeEncrypt(
        keyPair,
        serverPublicKey,
        userName,
        "data",
      );
      encodedPassword = await richartE2eeEncrypt(
        keyPair,
        serverPublicKey,
        password,
        "password",
      );
    } catch {
      throw new RichartApiError("protocol", "e2e_encrypt");
    }
    // 欄位名稱依官方 callIsRepeated／callLogin 實際送出的 body；檢核碼只在 isRepeated 驗證。
    const credentialFields = {
      pid: identity.toUpperCase(),
      userName: encodedUser.cipherHex,
      userMac: encodedUser.macHex,
      password: encodedPassword.cipherHex,
      mac: encodedPassword.macHex,
      sessionId,
    };
    const repeated = await this.post(
      "/AuthService/isRepeated",
      {
        ...credentialFields,
        securityCodeSessionId: captcha.securityCodeSessionId,
        securityCode: captcha.securityCode,
      },
      "is_repeated",
      true,
    );
    if (repeated.isRepeated === true) {
      throw new RichartApiError("session_conflict", "is_repeated");
    }
    await this.post(
      "/AuthService/login",
      {
        ...credentialFields,
        updatedApp: false,
        deviceInfo: { os: "Web", appVersion: "", deviceId: "" },
      },
      "login",
      true,
    );
  }

  getSavingAccount(): Promise<JsonRecord> {
    return this.post("/AccountService/getSavingAccount", {}, "saving_account");
  }

  getNewTransactions(): Promise<JsonRecord> {
    return this.post(
      "/HistoryService/getNewTransaction",
      {},
      "new_transactions",
    );
  }

  /** `month` 是往前回溯的月數（官方網銀由 1 起逐月往前查，最多 12）。 */
  getTransactions(month: number): Promise<JsonRecord> {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new RichartApiError("protocol", "transactions");
    }
    return this.post(
      "/HistoryService/getTransaction",
      { month, type: 2 },
      "transactions",
    );
  }

  getSubAccounts(): Promise<JsonRecord> {
    return this.post("/SubAccountService/getSubAccount", {}, "sub_accounts");
  }

  getTwdTimeDeposits(): Promise<JsonRecord> {
    return this.post(
      "/DepositService/getNtDepositOverviewForWebBank",
      {},
      "twd_time_deposits",
    );
  }

  async logout(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`${API_ROOT}/AuthService/logout`, {
        method: "GET",
        headers: this.headers(),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new RichartApiError("transport", "logout");
    }
    this.storeCookies(response);
    if (!response.ok) throw new RichartApiError("transport", "logout");
  }

  private headers(json = false): Record<string, string> {
    const cookie = [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-tw",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/WebBank/users/login?lang=zh-tw`,
      "User-Agent": USER_AGENT,
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    };
  }

  private async post(
    path: string,
    body: JsonRecord,
    operation: string,
    login = false,
  ): Promise<JsonRecord> {
    let response: Response;
    try {
      response = await this.fetcher(`${API_ROOT}${path}`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // 不傳遞 request body、銀行訊息或 cookie。
      throw new RichartApiError("transport", operation);
    }
    this.storeCookies(response);
    if (!response.ok) throw new RichartApiError("transport", operation);
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new RichartApiError("protocol", operation);
    }
    if (!isRecord(envelope)) throw new RichartApiError("protocol", operation);
    if (envelope.stat === "ok") {
      if (envelope.result === undefined || envelope.result === null) return {};
      if (!isRecord(envelope.result)) {
        throw new RichartApiError("protocol", operation);
      }
      return envelope.result;
    }
    if (envelope.stat === "error") {
      const code =
        typeof envelope.errorCode === "string" ? envelope.errorCode : "";
      const message =
        typeof envelope.errorMsg === "string" ? envelope.errorMsg : "";
      throw new RichartApiError(
        richartErrorKind(code, message, login),
        operation,
        safeBankCode(code),
      );
    }
    throw new RichartApiError("protocol", operation);
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

/**
 * 官方網銀登入元件的錯誤分流：使用者代號／密碼錯誤有專屬代碼，
 * 檢核碼錯誤則只能由訊息文字判斷。
 */
export function richartErrorKind(
  code: string,
  message: string,
  login: boolean,
): RichartErrorKind {
  if (code === "AUTH08001" || code === "AUTH08007") {
    return login ? "session_conflict" : "session_expired";
  }
  if (/^AUTH080(26|27|28|29)$/.test(code)) return "credentials";
  if (/^USER010(25|26|27|31)$/.test(code)) return "account_unavailable";
  if (code === "SYS0099" || code === "E2EE900") return "maintenance";
  if (
    message.includes("驗證碼有誤") ||
    message.includes("檢核碼") ||
    /verification/i.test(message)
  ) {
    return "captcha";
  }
  return login ? "credentials" : "protocol";
}

function safeBankCode(code: string): string | undefined {
  return /^[A-Z]{2,10}\d{2,6}$/.test(code) ? code : undefined;
}

export type RichartPayloads = {
  savingAccount: JsonRecord;
  /** `getNewTransaction` 與 `getTransaction` 各月份的 `result`。 */
  transactionPages: JsonRecord[];
  subAccounts: JsonRecord;
  twdTimeDeposits: JsonRecord;
};

/** 登入後在任何資料寫入前，取得一份完整、有上限的唯讀快照。 */
export async function collectRichartPayloads(
  client: RichartApiClient,
): Promise<RichartPayloads> {
  const savingAccount = await client.getSavingAccount();
  const transactionPages = [await client.getNewTransactions()];
  for (let month = 1; month <= BANK_SYNC_MONTHS; month += 1) {
    transactionPages.push(await client.getTransactions(month));
  }
  return {
    savingAccount,
    transactionPages,
    subAccounts: await client.getSubAccounts(),
    twdTimeDeposits: await client.getTwdTimeDeposits(),
  };
}

function nonempty(value: unknown, operation: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RichartApiError("protocol", operation);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
