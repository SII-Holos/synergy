import { describe, expect, test } from "bun:test"
import { browserOwnerKey } from "@ericsanchezok/synergy-browser-core"
import { browserProfilePartition, browserRuntimeOwnerKey, browserRuntimePartition } from "../src/browser-profile.js"

describe("browserProfilePartition", () => {
  test("member mapping is stable, preserves temporary lifetime and rejects an empty Runtime selector", () => {
    const persistent = "persist:synergy-browser-personal"
    expect(browserRuntimePartition("member", persistent)).toBe(browserRuntimePartition("member", persistent))
    expect(browserRuntimePartition("member", persistent).startsWith("persist:")).toBe(true)
    expect(browserRuntimePartition("member", "synergy-browser-temporary").startsWith("persist:")).toBe(false)
    expect(browserRuntimeOwnerKey(undefined, "canonical-owner")).toBe("canonical-owner")
    expect(browserRuntimeOwnerKey("member", "canonical-owner")).not.toBe(
      browserRuntimeOwnerKey("member", "other-owner"),
    )
    expect(() => browserRuntimeOwnerKey("", "canonical-owner")).toThrow("Runtime identity")
    expect(() => browserRuntimePartition("member", "persist:foreign")).toThrow("partition")
  })

  test("uses the owner session as the profile boundary", () => {
    const ownerKey = browserOwnerKey({ mode: "session", scopeID: "aG9tZQ", sessionID: "ses_1" })
    const first = browserProfilePartition(ownerKey)
    const second = browserProfilePartition(ownerKey)

    expect(first).toBe(second)
    expect(first.startsWith("persist:synergy-browser-")).toBe(true)
  })

  test("isolates different sessions and scopes", () => {
    const base = browserProfilePartition(browserOwnerKey({ mode: "session", scopeID: "aG9tZQ", sessionID: "ses_1" }))
    const differentSession = browserProfilePartition(
      browserOwnerKey({ mode: "session", scopeID: "aG9tZQ", sessionID: "ses_2" }),
    )
    const differentScope = browserProfilePartition(
      browserOwnerKey({ mode: "session", scopeID: "project", sessionID: "ses_1" }),
    )

    expect(differentSession).not.toBe(base)
    expect(differentScope).not.toBe(base)
  })
})
