import { describe, expect, test } from "bun:test"
import { browserProfilePartition } from "../src/browser-profile.js"

describe("browserProfilePartition", () => {
  test("uses the owner session instead of the tab as the profile boundary", () => {
    const first = browserProfilePartition({
      sessionID: "ses_1",
      routeDirectory: "aG9tZQ",
    })
    const second = browserProfilePartition({
      sessionID: "ses_1",
      routeDirectory: "aG9tZQ",
    })

    expect(first).toBe(second)
    expect(first.startsWith("persist:synergy-browser-")).toBe(true)
  })

  test("isolates different sessions and scopes", () => {
    const base = browserProfilePartition({
      sessionID: "ses_1",
      routeDirectory: "aG9tZQ",
    })
    const differentSession = browserProfilePartition({
      sessionID: "ses_2",
      routeDirectory: "aG9tZQ",
    })
    const differentScope = browserProfilePartition({
      sessionID: "ses_1",
      routeDirectory: "project",
    })

    expect(differentSession).not.toBe(base)
    expect(differentScope).not.toBe(base)
  })
})
