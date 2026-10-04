/**
 * Richart 網銀登入的端對端加密（`/WebBank/e2eeclient.js` 的 `DataEncode`／`PwdEncode`）。
 *
 * 用戶端 P-256 金鑰對直接與伺服器公鑰做 ECDH（不另產生暫時金鑰），
 * 以 SHA-512(sharedX || 00000001) 衍生 64 bytes：前半為 AES-256-CBC 金鑰、後半為
 * HMAC-SHA256 金鑰，IV 取 MAC 金鑰前 16 bytes。使用者代號（data）會先對調前後半。
 * MAC 涵蓋 IV、用戶端公鑰（65 bytes 未壓縮）與密文。
 */

export type RichartE2eeKind = "data" | "password";

export type RichartE2eeKeyPair = {
  privateKey: CryptoKey;
  /** 0x04 開頭、65 bytes 的未壓縮公鑰，小寫 hex。 */
  publicKeyHex: string;
};

export type RichartE2eeCipher = { cipherHex: string; macHex: string };

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

export async function createRichartE2eeKeyPair(): Promise<RichartE2eeKeyPair> {
  const pair = (await crypto.subtle.generateKey(CURVE, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKeyHex: toHex(new Uint8Array(raw as ArrayBuffer)),
  };
}

export async function richartE2eeEncrypt(
  keyPair: RichartE2eeKeyPair,
  serverPublicKeyHex: string,
  plaintext: string,
  kind: RichartE2eeKind,
): Promise<RichartE2eeCipher> {
  const serverKey = await crypto.subtle.importKey(
    "raw",
    fromHex(serverPublicKeyHex, 65),
    CURVE,
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey },
      keyPair.privateKey,
      256,
    ),
  );
  let derived = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-512",
      concat(shared, new Uint8Array([0, 0, 0, 1])),
    ),
  );
  if (kind === "data") {
    derived = concat(derived.subarray(32), derived.subarray(0, 32));
  }
  const encKey = derived.subarray(0, 32);
  const macKey = derived.subarray(32, 64);
  const iv = macKey.subarray(0, 16);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    encKey,
    "AES-CBC",
    false,
    ["encrypt"],
  );
  // WebCrypto AES-CBC 固定使用 PKCS#7 padding，與銀行端 aes-js pkcs7 相同。
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      aesKey,
      new TextEncoder().encode(plaintext),
    ),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      concat(iv, fromHex(keyPair.publicKeyHex, 65), cipher),
    ),
  );
  return { cipherHex: toHex(cipher), macHex: toHex(mac) };
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function fromHex(hex: string, expectedLength: number): Uint8Array<ArrayBuffer> {
  if (!new RegExp(`^[0-9a-fA-F]{${expectedLength * 2}}$`).test(hex)) {
    throw new Error("Richart E2EE 公鑰格式不符。");
  }
  const out = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}
