import { describe, expect, it } from "vitest";
import { encryptDbsPassword } from "../../../src/sources/dbs/password";
import { dbsPasswordVector as vector } from "./fixtures/password-vector";

describe("星展密碼加密", () => {
  it("與官方 RIBLogon.encyptPwd 在相同填充下輸出一致", () => {
    const padding = Buffer.from(vector.padding, "hex");
    expect(
      encryptDbsPassword(
        vector.password,
        vector.random,
        vector.modulus,
        (length) => {
          expect(length).toBe(padding.length);
          return new Uint8Array(padding);
        },
      ),
    ).toBe(vector.encrypted);
  });

  it("拒絕超過 30 字元的密碼與格式錯誤的公鑰", () => {
    expect(() =>
      encryptDbsPassword("x".repeat(31), vector.random, vector.modulus),
    ).toThrow("密碼格式不符");
    expect(() => encryptDbsPassword("pw", vector.random, "abcd")).toThrow(
      "公鑰格式不符",
    );
  });
});
