import { describe, expect, test } from "bun:test"
import { BrowserNativeLease } from "../src/native-lease"
import { browserOwnerKey } from "../src/protocol"

describe("BrowserNativeLease", () => {
  test("signs owner/server-bound short-lived claims and rejects tampering and expiry", () => {
    const secret = "a".repeat(64)
    const ticket = BrowserNativeLease.issue(secret, {
      ownerKey: browserOwnerKey({ mode: "session", scopeID: "scope", sessionID: "session-1" }),
      serverOrigin: "http://127.0.0.1:4096/path",
      now: 1_000,
      ttlMs: 5_000,
    })
    expect(BrowserNativeLease.verify(secret, ticket, 2_000)).toMatchObject({
      protocolVersion: 2,
      ownerKey: browserOwnerKey({ mode: "session", scopeID: "scope", sessionID: "session-1" }),
      serverOrigin: "http://127.0.0.1:4096",
      expiresAt: 6_000,
    })
    expect(() => BrowserNativeLease.verify("b".repeat(64), ticket, 2_000)).toThrow(/signature/i)
    expect(() => BrowserNativeLease.verify(secret, `${ticket}x`, 2_000)).toThrow(/signature|malformed/i)
    expect(() => BrowserNativeLease.verify(secret, ticket, 6_001)).toThrow(/expired/i)
  })
})
