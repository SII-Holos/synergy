import { describe, expect, test } from "bun:test"
import {
  NPM_REGISTRY_WAIT_ATTEMPTS,
  NPM_REGISTRY_WAIT_DELAY_MS,
  npmTagMatches,
} from "../../../script/release/shared/runtime"

describe("release npm registry waits", () => {
  test("uses a five minute registry visibility budget", () => {
    expect(NPM_REGISTRY_WAIT_ATTEMPTS * NPM_REGISTRY_WAIT_DELAY_MS).toBe(5 * 60_000)
  })

  test("waits for a dist-tag to converge", async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return Response.json({ next: calls === 1 ? "3.0.0" : "3.0.1" })
    }) as typeof fetch
    try {
      expect(await npmTagMatches("@ericsanchezok/synergy-sdk", "next", "3.0.1", { attempts: 2, delay: 1 })).toBe(true)
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
