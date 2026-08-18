import { describe, expect, test } from "bun:test"
import { retry } from "../src/retry"

describe("retry", () => {
  test("returns immediately on the first success", async () => {
    let calls = 0
    const value = await retry(async () => {
      calls++
      return "ok"
    })
    expect(value).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries transient errors until success", async () => {
    let calls = 0
    const value = await retry(
      async () => {
        calls++
        if (calls < 3) throw new Error("network request failed")
        return "recovered"
      },
      { attempts: 3, delay: 1, factor: 2 },
    )
    expect(value).toBe("recovered")
    expect(calls).toBe(3)
  })

  test("gives up after the attempt budget and rethrows the last error", async () => {
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("network connection was lost")
        },
        { attempts: 2, delay: 1 },
      ),
    ).rejects.toThrow("connection was lost")
    expect(calls).toBe(2)
  })

  test("matches a wide range of transient error classes by message", async () => {
    for (const message of [
      "Load failed",
      "the network request failed",
      "fetch failed: failed to fetch",
      "ECONNRESET",
      "econnrefused",
      "ETIMEDOUT",
      "socket hang up",
    ]) {
      let calls = 0
      await expect(
        retry(
          async () => {
            calls++
            throw new Error(message)
          },
          { attempts: 2, delay: 1 },
        ),
      ).rejects.toThrow(message)
      expect(calls).toBe(2)
    }
  })

  test("does not retry non-transient errors", async () => {
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("validation failed")
        },
        { attempts: 3, delay: 1 },
      ),
    ).rejects.toThrow("validation failed")
    expect(calls).toBe(1)
  })

  test("uses the custom retryIf predicate when provided", async () => {
    let calls = 0
    const value = await retry(
      async () => {
        calls++
        if (calls === 1) throw new Error("code 7")
        return "ok"
      },
      { attempts: 2, delay: 1, retryIf: (error) => error instanceof Error && error.message === "code 7" },
    )
    expect(value).toBe("ok")
    expect(calls).toBe(2)
  })

  test("handles non-Error throw values with transient messages", async () => {
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw "failed to fetch"
        },
        { attempts: 2, delay: 1 },
      ),
    ).rejects.toBe("failed to fetch")
    expect(calls).toBe(2)
  })

  test("caps backoff delay at maxDelay", async () => {
    const startedAt = Date.now()
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("econnreset")
        },
        { attempts: 2, delay: 50, factor: 100, maxDelay: 60 },
      ),
    ).rejects.toThrow()
    const elapsedMs = Date.now() - startedAt
    expect(calls).toBe(2)
    expect(elapsedMs).toBeLessThan(250)
  })
})
