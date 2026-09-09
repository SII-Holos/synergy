import { describe, expect, test } from "bun:test"
import { browserOwnerKey } from "@ericsanchezok/synergy-browser"
import { browserProfilePartition } from "../src/browser-profile.js"

describe("browserProfilePartition", () => {
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
