import { describe, expect, it } from "vitest";
import {
  createRichartE2eeKeyPair,
  richartE2eeEncrypt,
  type RichartE2eeKeyPair,
} from "../../../src/sources/richart/e2ee";

// 以 Richart 官方 `/WebBank/e2eeclient.js` 在本機產生的合成金鑰與輸出；不含任何真實帳密。
const vector = {
  clientPrivateKey:
    "6e950a4119a4ef20d5b3b2ac18901e5873aea4982eebf5d90003a69ac86cd56a",
  clientPublicKey:
    "0447077d301cd8d4d3e1ebc9a3a5f107e5e0103205bfca8a9784144defc1443096fb186fdd65c05b6faf46a9ec4f675e0fac1835a5c6d71a22d771f2aee4b457dc",
  serverPublicKey:
    "04f43f34e1730594fd4ea1b0cc6bc9182ea23d69b26f2f82fd7b3b1068aef3c162ba04559daa14f243f221edc8f67bef50e8aeebb08d3b887df138f3a47558f42e",
  account: {
    plaintext: "demo1234",
    cipherHex: "050f39e6f321d9910b11f4c858556b3a",
    macHex: "1d55ded4daa3c5df83c0295b24f22ca8ac261831948adfb4977deb499893e9c1",
  },
  password: {
    plaintext: "pass5678",
    cipherHex: "d2bd2ea3dc4667bc31c15e441011d6b5",
    macHex: "b6a349d0e877c114b037aca412b20e8c5115635fbf83f386d2c7c48401cc62ef",
  },
};

async function vectorKeyPair(): Promise<RichartE2eeKeyPair> {
  const publicKey = Buffer.from(vector.clientPublicKey, "hex");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(vector.clientPrivateKey, "hex").toString("base64url"),
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33, 65).toString("base64url"),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKeyHex: vector.clientPublicKey };
}

describe("Richart E2EE", () => {
  it("使用者代號與官方 DataEncode 輸出一致", async () => {
    await expect(
      richartE2eeEncrypt(
        await vectorKeyPair(),
        vector.serverPublicKey,
        vector.account.plaintext,
        "data",
      ),
    ).resolves.toEqual({
      cipherHex: vector.account.cipherHex,
      macHex: vector.account.macHex,
    });
  });

  it("密碼與官方 PwdEncode 輸出一致", async () => {
    await expect(
      richartE2eeEncrypt(
        await vectorKeyPair(),
        vector.serverPublicKey,
        vector.password.plaintext,
        "password",
      ),
    ).resolves.toEqual({
      cipherHex: vector.password.cipherHex,
      macHex: vector.password.macHex,
    });
  });

  it("產生 65 bytes 未壓縮公鑰並拒絕格式錯誤的伺服器公鑰", async () => {
    const pair = await createRichartE2eeKeyPair();
    expect(pair.publicKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    await expect(
      richartE2eeEncrypt(pair, "04abcd", "x", "password"),
    ).rejects.toThrow("公鑰格式不符");
  });
});
