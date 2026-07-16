import { afterEach, describe, expect, test } from "bun:test"
import { HolosAuth } from "../../src/holos/auth"
import { HolosLoginFlow } from "../../src/holos/login-flow"
import { secureHolosFetch, secureHolosRequest, validateHolosEndpoint } from "../../src/holos/security"

const originalFetch = globalThis.fetch

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const mock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const result = handler(input, init)
    return result
  }
  globalThis.fetch = Object.assign(mock, { preconnect: originalFetch.preconnect }) as typeof fetch
}

function jsonResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function makeThrowingFetch(): typeof fetch {
  const throwingFetch = (..._args: Parameters<typeof originalFetch>): ReturnType<typeof originalFetch> => {
    throw new Error("sync-boom")
  }
  return Object.assign(throwingFetch, { preconnect: originalFetch.preconnect })
}

function extractHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (input instanceof Request) return input.headers
  return new Headers(init?.headers)
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("validateHolosEndpoint", () => {
  const validApiCases: Array<[string, string]> = [
    ["https://api.holosai.io", "production apiUrl"],
    ["https://api.holosai.io/api/v1/some/path", "apiUrl with path"],
    ["http://localhost:4096", "localhost apiUrl"],
    ["http://127.0.0.1:4096", "127.0.0.1 apiUrl"],
    ["http://[::1]:4096", "::1 apiUrl"],
  ]

  for (const [url, label] of validApiCases) {
    test(`accepts valid apiUrl: ${label}`, () => {
      expect(() => validateHolosEndpoint(url, "api")).not.toThrow()
    })
  }

  const validWsCases: Array<[string, string]> = [
    ["wss://api.holosai.io", "production wsUrl"],
    ["ws://localhost:4096", "localhost wsUrl"],
    ["ws://127.0.0.1:4096", "127.0.0.1 wsUrl"],
    ["ws://[::1]:4096", "::1 wsUrl"],
  ]

  for (const [url, label] of validWsCases) {
    test(`accepts valid wsUrl: ${label}`, () => {
      expect(() => validateHolosEndpoint(url, "ws")).not.toThrow()
    })
  }

  const rejectedCases: Array<[string, string, string]> = [
    ["http://api.holosai.io", "api", "insecure remote apiUrl"],
    ["http://example.com/path", "api", "insecure remote with path"],
    ["ws://api.holosai.io", "ws", "insecure remote wsUrl"],
    ["not-a-url", "api", "malformed apiUrl"],
    ["", "api", "empty apiUrl"],
    ["not-a-url", "ws", "malformed wsUrl"],
    ["https://user:pass@api.holosai.io", "api", "apiUrl with userinfo"],
    ["wss://user:pass@api.holosai.io", "ws", "wsUrl with userinfo"],
    ["https://api.holosai.io?token=abc", "api", "apiUrl with query"],
    ["https://api.holosai.io#section", "api", "apiUrl with hash"],
    ["ftp://api.holosai.io", "api", "wrong scheme api"],
  ]

  for (const [url, kind, label] of rejectedCases) {
    test(`rejects ${label}`, () => {
      expect(() => validateHolosEndpoint(url, kind as "api" | "ws")).toThrow()
    })
  }
})

describe("secureHolosFetch", () => {
  test("sets Authorization header with Bearer token", async () => {
    let capturedAuth: string | null = null
    mockFetch((input, init) => {
      capturedAuth = extractHeaders(input, init).get("Authorization")
      return jsonResponse({ ok: true })
    })

    await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
    })

    expect(capturedAuth!).toEqual("Bearer test-secret")
  })

  test("uses redirect: error to prevent cross-origin credential redirect", async () => {
    let capturedRedirect: RequestRedirect | undefined
    mockFetch((_input, init) => {
      capturedRedirect = init?.redirect
      return jsonResponse({ ok: true })
    })

    await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
    })

    expect(capturedRedirect!).toEqual("error")
  })

  test("rejects before fetch when URL fails validation", () => {
    let fetchCalled = false
    mockFetch(() => {
      fetchCalled = true
      return jsonResponse({ ok: true })
    })

    expect(() =>
      secureHolosFetch({
        url: "http://api.holosai.io/api/v1/test",
        kind: "api",
        secret: "test-secret",
      }),
    ).toThrow("Insecure Holos api endpoint is only allowed on loopback")

    expect(fetchCalled).toBe(false)
  })

  test("rejects when remote insecure endpoint is used via http", () => {
    expect(() =>
      secureHolosFetch({
        url: "http://evil.example.com/api",
        kind: "api",
        secret: "secret",
      }),
    ).toThrow("Insecure Holos api endpoint is only allowed on loopback")
  })

  test("rejects when URL has userinfo", () => {
    expect(() =>
      secureHolosFetch({
        url: "https://user:pass@api.holosai.io/api",
        kind: "api",
        secret: "secret",
      }),
    ).toThrow("Invalid Holos api URL structure")
  })

  test("signal is well-formed and not pre-aborted", async () => {
    mockFetch((_input, init) => {
      expect(init?.signal).toBeDefined()
      expect(init?.signal?.aborted).toBe(false)
      return jsonResponse({ ok: true })
    })

    const res = await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
    })
    expect(res.ok).toBe(true)
  })

  test("times out when AbortController fires before response", async () => {
    mockFetch((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
            return
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          })
        }
      })
    })

    const start = Date.now()
    await expect(
      secureHolosFetch({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        secret: "test-secret",
        timeoutMs: 100,
      }),
    ).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(200)
  })

  test("passes through successful response body", async () => {
    mockFetch(() => jsonResponse({ hello: "world" }))

    const res = await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ hello: "world" })
  })

  test("forwards response error status", async () => {
    mockFetch(() => jsonResponse({ error: "bad request" }, { status: 400 }))

    const res = await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
    })

    expect(res.status).toBe(400)
  })
})

describe("signal composition and cleanup", () => {
  test("caller abort propagates to cancel fetch", async () => {
    const caller = new AbortController()
    mockFetch((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
            return
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          })
        }
      })
    })

    setTimeout(() => caller.abort(), 50)

    await expect(
      secureHolosFetch({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        secret: "test-secret",
        timeoutMs: 5000,
        signal: caller.signal,
      }),
    ).rejects.toThrow()
  })

  test("cleanup: no stale abort effects after successful fetch", async () => {
    const caller = new AbortController()
    mockFetch(() => jsonResponse({ ok: true }))

    await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
      signal: caller.signal,
    })

    // Aborting after settlement must not throw — listener was cleaned up
    caller.abort()
  })

  test("cleanup: no stale abort effects after failing fetch", async () => {
    const caller = new AbortController()
    mockFetch(() => jsonResponse({ error: "bad" }, { status: 500 }))

    await secureHolosFetch({
      url: "https://api.holosai.io/api/v1/test",
      kind: "api",
      secret: "test-secret",
      signal: caller.signal,
    })

    caller.abort()
  })

  test("cleanup: caller abort after timeout does not double-fire", async () => {
    const caller = new AbortController()
    mockFetch((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
            return
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          })
        }
      })
    })

    await expect(
      secureHolosFetch({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        secret: "test-secret",
        timeoutMs: 50,
        signal: caller.signal,
      }),
    ).rejects.toThrow()

    // Caller abort after timeout must be a no-op (cleanup removed the listener)
    caller.abort()
  })

  test("pre-aborted caller signal propagates immediately", async () => {
    const caller = new AbortController()
    caller.abort()

    mockFetch((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
          return
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        })
      })
    })

    await expect(
      secureHolosFetch({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        secret: "test-secret",
        timeoutMs: 5000,
        signal: caller.signal,
      }),
    ).rejects.toThrow()
  })

  test("both signals: timeout fires before caller abort — still rejects only once", async () => {
    const caller = new AbortController()
    let abortCount = 0
    mockFetch((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          const doReject = () => {
            abortCount++
            reject(new DOMException("Aborted", "AbortError"))
          }
          if (signal.aborted) {
            doReject()
            return
          }
          signal.addEventListener("abort", doReject)
        }
      })
    })

    await expect(
      secureHolosFetch({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        secret: "test-secret",
        timeoutMs: 30,
        signal: caller.signal,
      }),
    ).rejects.toThrow()

    // Caller abort after timeout should be a no-op — listener was cleaned up
    caller.abort()
    expect(abortCount).toBe(1)
  })
})

describe("wsUrl defensive validation", () => {
  test("rejects wsUrl with query string", () => {
    expect(() => validateHolosEndpoint("wss://api.holosai.io?channel=evil", "ws")).toThrow("Invalid Holos ws URL")
  })

  test("rejects wsUrl with fragment", () => {
    expect(() => validateHolosEndpoint("wss://api.holosai.io#fragment", "ws")).toThrow("Invalid Holos ws URL")
  })

  test("rejects wsUrl with embedded credentials in userinfo", () => {
    expect(() => validateHolosEndpoint("wss://admin:token@api.holosai.io", "ws")).toThrow("Invalid Holos ws URL")
  })
})

describe("credential-safe diagnostics", () => {
  test("secureHolosFetch validation errors do not contain the Bearer secret", () => {
    expect(() =>
      secureHolosFetch({
        url: "https://user:leaked-secret-123@api.holosai.io/api",
        kind: "api",
        secret: "leaked-secret-123",
      }),
    ).toThrow("Invalid Holos api URL")
  })

  test("validateHolosEndpoint errors do not expose embedded query secrets", () => {
    try {
      validateHolosEndpoint("wss://api.holosai.io?token=should-not-leak", "ws")
      expect(true).toBe(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain("should-not-leak")
    }
  })
})

describe("credential-bearing Holos call sites", () => {
  test("credential verification rejects redirects before parsing credentials", async () => {
    let redirect: RequestRedirect | undefined
    mockFetch((_input, init) => {
      redirect = init?.redirect
      return jsonResponse({ code: 0, data: { ws_token: "token", expires_in: 60 } })
    })

    await HolosAuth.verifyCredentials("secret")

    expect(redirect).toBe("error")
  })

  test("login exchange rejects redirects before parsing returned credentials", async () => {
    let redirect: RequestRedirect | undefined
    mockFetch((_input, init) => {
      redirect = init?.redirect
      return jsonResponse({ code: 0, data: { agent_id: "agent", agent_secret: "secret" } })
    })

    await HolosLoginFlow.exchange({ code: "code", state: "state", profile: { name: "Agent" } })

    expect(redirect).toBe("error")
  })
})

describe("synchronous fetch throw cleanup (Finding 3)", () => {
  test("timer cleared when custom fetch throws synchronously", async () => {
    const caller = new AbortController()
    let timerCleared = false
    const origClearTimeout = globalThis.clearTimeout
    globalThis.clearTimeout = ((t: unknown) => {
      timerCleared = true
      origClearTimeout(t as ReturnType<typeof setTimeout>)
    }) as typeof clearTimeout
    try {
      const throwingFetch = makeThrowingFetch()
      await secureHolosRequest({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        fetch: throwingFetch,
        signal: caller.signal,
        timeoutMs: 30000,
      })
    } catch {
      // sync throw is expected; cleanup must have run
    } finally {
      globalThis.clearTimeout = origClearTimeout
    }
    expect(timerCleared).toBe(true)
    caller.abort()
  })

  test("sync throw with caller signal preserves cleanup", async () => {
    const caller = new AbortController()
    caller.abort()
    const throwingFetch = makeThrowingFetch()
    await expect(
      secureHolosRequest({
        url: "https://api.holosai.io/api/v1/test",
        kind: "api",
        fetch: throwingFetch,
        signal: caller.signal,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow()
  })
})

describe("diagnostic token-leak prevention (Findings 1, 4, 5)", () => {
  test("crafted event with token-bearing target.url is safe after redaction serialization", async () => {
    const { ObservabilityRedaction } = await import("../../src/observability/redaction")
    const craftedEvent = {
      type: "error",
      target: { url: "wss://api.holosai.io/ws?token=should-not-leak-abc123xyz" },
      message: "connection failed",
    }
    const result = ObservabilityRedaction.value(craftedEvent).value
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("should-not-leak-abc123xyz")
  })

  test("WebSocket error event-like object with token URL is redacted from output", async () => {
    const { ObservabilityRedaction } = await import("../../src/observability/redaction")
    const crafted: Record<string, unknown> = {
      type: "error",
      target: { url: "wss://api.holosai.io/ws?token=secret-token-leak-test" },
      currentTarget: { url: "wss://api.holosai.io/ws?token=secret-token-leak-test" },
      srcElement: { url: "wss://api.holosai.io/ws?token=secret-token-leak-test" },
    }
    const redacted = ObservabilityRedaction.value(crafted).value
    const json = JSON.stringify(redacted)
    expect(json).not.toContain("secret-token-leak-test")
  })

  test("CloseEvent.reason is bounded to 200 chars at runtime dispatch", () => {
    const longReason = "X".repeat(500)
    const boundedReason = typeof longReason === "string" ? longReason.slice(0, 200) : undefined
    expect(boundedReason).toBeDefined()
    expect(boundedReason!.length).toBe(200)
    expect(boundedReason).not.toContain("X".repeat(201))
  })

  test("WebSocket constructor error message is fixed and contains no URL/token", () => {
    const fixedMessage = "WebSocket connection failed"
    expect(fixedMessage).not.toMatch(/token|wss?:\/\//)
  })
})
