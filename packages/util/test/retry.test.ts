import { describe, expect, test } from "bun:test"
import { retry, retryAfterMs } from "../src/retry"

describe("retry", () => {
  test.each([
    "ETIMEOUT",
    "EAI_AGAIN",
    "ESERVFAIL",
    "EHOSTUNREACH",
    "ENETDOWN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ])("recovers from wrapped %s errors", async (code) => {
    let calls = 0
    const result = await retry(
      async () => {
        if (++calls === 1)
          throw new TypeError("request failed", {
            cause: new AggregateError([Object.assign(new Error("transport failed"), { code })]),
          })
        return "recovered"
      },
      { delay: 1 },
    )
    expect(result).toBe("recovered")
    expect(calls).toBe(2)
  })

  test.each(["ENOTFOUND", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_INVALID_URL", "UND_ERR_ABORTED"])(
    "does not hide a permanent or cancelled %s behind fetch failed",
    async (code) => {
      let calls = 0
      const error = new TypeError("fetch failed", { cause: Object.assign(new Error("failure"), { code }) })
      await expect(
        retry(
          async () => {
            calls++
            throw error
          },
          { delay: 1 },
        ),
      ).rejects.toBe(error)
      expect(calls).toBe(1)
    },
  )

  test("cancels backoff without starting another attempt", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled by caller")
    let calls = 0
    const pending = retry(
      async () => {
        calls++
        throw new Error("failed to fetch")
      },
      {
        signal: controller.signal,
        delay: 60_000,
        retryIf() {
          controller.abort(reason)
          return true
        },
      },
    )
    await expect(pending).rejects.toBe(reason)
    expect(calls).toBe(1)
  })

  test("does not start an already cancelled request", async () => {
    let calls = 0
    const reason = new Error("cancelled")
    await expect(
      retry(
        async () => {
          calls++
        },
        { signal: AbortSignal.abort(reason) },
      ),
    ).rejects.toBe(reason)
    expect(calls).toBe(0)
  })
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

describe("retry-after", () => {
  test("accepts case-insensitive headers, finite milliseconds, seconds and HTTP dates", () => {
    expect(retryAfterMs({ "Retry-After": "3" })).toBe(3000)
    expect(retryAfterMs(new Headers({ "retry-after-ms": "12.5" }))).toBe(12.5)
    expect(retryAfterMs({ "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" }, 1000)).toBe(9000)
  })
  test.each(["-1", "Infinity", "NaN", "3seconds", "1e9", "", "1.5"])("rejects malformed Retry-After %s", (value) => {
    expect(retryAfterMs({ "retry-after": value })).toBeUndefined()
  })
  test("falls through malformed milliseconds to a valid seconds hint", () => {
    expect(retryAfterMs({ "retry-after-ms": "-10", "Retry-After": "2" })).toBe(2000)
  })
})

test("malformed diagnostic headers cannot replace the original network failure", () => {
  expect(retryAfterMs({ "invalid\nheader": "value", "retry-after": "1" })).toBeUndefined()
})
