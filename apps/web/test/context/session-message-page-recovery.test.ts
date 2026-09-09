import { describe, expect, test } from "bun:test"
import { loadOlderOrRecoverLatest } from "../../src/context/session-message-page-recovery"

describe("session message page recovery", () => {
  test("keeps history mode after an older page loads", async () => {
    let latestLoads = 0
    const result = await loadOlderOrRecoverLatest({
      loadOlder: async () => {},
      loadLatest: async () => {
        latestLoads += 1
      },
    })

    expect(result).toBe("history")
    expect(latestLoads).toBe(0)
  })

  test("reloads the latest page when the cursor is stale", async () => {
    let latestLoads = 0
    const result = await loadOlderOrRecoverLatest({
      loadOlder: async () => {
        throw { name: "SessionMessagePageCursorStaleError" }
      },
      loadLatest: async () => {
        latestLoads += 1
      },
    })

    expect(result).toBe("latest")
    expect(latestLoads).toBe(1)
  })

  test("preserves non-stale failures", async () => {
    const failure = new Error("offline")
    await expect(
      loadOlderOrRecoverLatest({
        loadOlder: async () => {
          throw failure
        },
        loadLatest: async () => {},
      }),
    ).rejects.toBe(failure)
  })
})
