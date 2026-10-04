/**
 * 星展網銀登入密碼加密（`/digitw/public/js/RIBLogon.js` 的 `encyptPwd`）。
 *
 * 區塊 = 隨機填充 ‖ 伺服器 random ‖ 密碼（30 bytes，不足補 0xFF），長度等於模數。
 * 填充第 0、1、10 byte 固定為 00、02、00，其餘填充不得為 0（銀行以 0x27 取代）。
 * 以 e = 65537 做未再填充的 RSA（m^e mod n），輸出補零到模數長度的小寫 hex。
 */
export function encryptDbsPassword(
  password: string,
  randomHex: string,
  modulusHex: string,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): string {
  if (
    !/^[0-9a-f]+$/i.test(modulusHex) ||
    ![256, 512].includes(modulusHex.length)
  ) {
    throw new Error("星展公鑰格式不符。");
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(randomHex)) {
    throw new Error("星展登入亂數格式不符。");
  }
  if (!/^[\x20-\x7e]{1,30}$/.test(password)) {
    throw new Error("星展密碼格式不符。");
  }
  const blockLength = modulusHex.length / 2;
  const random = hexToBytes(randomHex);
  const padLength = blockLength - random.length - 30;
  if (padLength < 11) throw new Error("星展登入亂數長度不符。");

  const block = new Uint8Array(blockLength);
  const pad = randomBytes(padLength);
  for (let index = 0; index < padLength; index += 1) {
    block[index] = pad[index] === 0 ? 0x27 : pad[index]!;
  }
  block[0] = 0x00;
  block[1] = 0x02;
  block[10] = 0x00;
  block.set(random, padLength);
  const passwordBytes = new Uint8Array(30).fill(0xff);
  for (let index = 0; index < password.length; index += 1) {
    passwordBytes[index] = password.charCodeAt(index);
  }
  block.set(passwordBytes, padLength + random.length);

  const modulus = BigInt(`0x${modulusHex}`);
  const message = BigInt(`0x${bytesToHex(block)}`);
  return modPow(message, 65537n, modulus)
    .toString(16)
    .padStart(modulusHex.length, "0");
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    remaining >>= 1n;
  }
  return result;
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
