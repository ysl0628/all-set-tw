import { describe, expect, it } from "vitest";
import {
  serializePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../../src/features/sync/connector-state";

describe("connector state boundaries", () => {
  it("removes reusable browser sessions from bank cursors", () => {
    expect(
      splitConnectorCursorState(
        "esun",
        JSON.stringify({
          sessionCookies: "sensitive-cookie",
          sessionExpiresAt: "2026-07-29T12:00:00.000Z",
          syncedAt: "2026-07-29T11:00:00.000Z",
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "2026-07-29T11:00:00.000Z" }),
      secretState: {
        sessionCookies: "sensitive-cookie",
        sessionExpiresAt: "2026-07-29T12:00:00.000Z",
      },
    });
  });

  it("keeps Mega Bank CAPTCHA sessions out of the cursor", () => {
    expect(
      splitConnectorCursorState(
        "megabank",
        JSON.stringify({
          pendingSession: "synthetic-token",
          pendingSessionExpiresAt: "2026-09-25T08:02:00.000Z",
          captcha: "12345",
          otp: "654321",
          syncedAt: "2026-09-25T08:01:00.000Z",
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "2026-09-25T08:01:00.000Z" }),
      secretState: {
        pendingSession: "synthetic-token",
        pendingSessionExpiresAt: "2026-09-25T08:02:00.000Z",
        captcha: "12345",
        otp: "654321",
      },
    });
    expect(
      serializePublicConnectorConfig("megabank", {
        pendingSession: "synthetic-token",
      }),
    ).toBeNull();
  });

  it("keeps HSBC CAPTCHA challenges out of the cursor and public config", () => {
    expect(
      splitConnectorCursorState(
        "hsbc",
        JSON.stringify({
          captchaKey: "synthetic-key",
          captchaCookies: "BFFSESSION=synthetic",
          captchaExpiresAt: 1_790_000_000_000,
          syncedAt: "2026-10-03T08:01:00.000Z",
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "2026-10-03T08:01:00.000Z" }),
      secretState: {
        captchaKey: "synthetic-key",
        captchaCookies: "BFFSESSION=synthetic",
        captchaExpiresAt: 1_790_000_000_000,
      },
    });
    expect(
      serializePublicConnectorConfig("hsbc", {
        account: "demo-user",
        captchaKey: "synthetic-key",
      }),
    ).toBeNull();
  });

  it("keeps Richart CAPTCHA sessions out of the cursor and public config", () => {
    expect(
      splitConnectorCursorState(
        "richart",
        JSON.stringify({
          captchaSessionId: "CMPLogin_synthetic",
          captchaCookies: { JSESSIONID: "synthetic" },
          captchaExpiresAt: 1_790_000_000_000,
          syncedAt: "2026-10-04T08:01:00.000Z",
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "2026-10-04T08:01:00.000Z" }),
      secretState: {
        captchaSessionId: "CMPLogin_synthetic",
        captchaCookies: { JSESSIONID: "synthetic" },
        captchaExpiresAt: 1_790_000_000_000,
      },
    });
    expect(
      serializePublicConnectorConfig("richart", {
        userId: "A123456789",
        account: "demo1234",
        captchaCookies: { JSESSIONID: "synthetic" },
      }),
    ).toBeNull();
  });

  it("keeps TDCC trade watermarks while encrypting device session state", () => {
    expect(
      splitConnectorCursorState(
        "tdcc",
        JSON.stringify({
          deviceId: "device-id",
          devType: "Android:14",
          devModel: "SM-G991B",
          session: { tokenId: "token", richUrl: null },
          tradeCursors: { account: { newest: "trade-1" } },
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({
        tradeCursors: { account: { newest: "trade-1" } },
      }),
      secretState: {
        deviceId: "device-id",
        devType: "Android:14",
        devModel: "SM-G991B",
        session: { tokenId: "token", richUrl: null },
      },
    });
  });
});
