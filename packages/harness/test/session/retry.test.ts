import { describe, expect, test } from "bun:test"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { APICallError } from "ai"
import { ProviderAuthRecovery } from "../../src/provider/auth-recovery"
import { ProviderModelUnavailableError } from "../../src/provider/model-unavailable-error"

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

describe("session.retry.delay", () => {
  test("caps fallback delay even when unrelated headers exist", () => {
    const delay = SessionRetry.delay(10, apiError({ "content-type": "application/json" }))
    expect(delay).toBeGreaterThanOrEqual(15000)
    expect(delay).toBeLessThanOrEqual(30000)
  })
  test.each(["-1", "Infinity", "3garbage"])("ignores unsafe retry-after-ms %s", (value) => {
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": value }))).toBeGreaterThanOrEqual(1000)
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": value }))).toBeLessThanOrEqual(2000)
  })
  test("sleep rejects an already aborted signal", async () => {
    const reason = new DOMException("cancelled", "AbortError")
    await expect(SessionRetry.sleep(1, AbortSignal.abort(reason))).rejects.toBe(reason)
  })
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, () => 1))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(15000)
    expect(d).toBeLessThanOrEqual(25000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error, () => 1)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error, () => 1)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error, () => 1)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("sleep caps delay to max 32-bit signed integer to avoid TimeoutOverflowWarning", async () => {
    const controller = new AbortController()

    const warnings: string[] = []
    const originalWarn = process.emitWarning
    process.emitWarning = (warning: string | Error) => {
      warnings.push(typeof warning === "string" ? warning : warning.message)
    }

    const promise = SessionRetry.sleep(2_560_914_000, controller.signal)
    controller.abort()

    try {
      await promise
    } catch {}

    process.emitWarning = originalWarn
    expect(warnings.some((w) => w.includes("TimeoutOverflowWarning"))).toBe(false)
  })
})

describe("session.message-v2.fromError", () => {
  test.each(["ETIMEOUT", "EHOSTUNREACH", "ESERVFAIL", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT"])(
    "preserves retry classification for nested %s through the worker protocol",
    (code) => {
      const source = new TypeError("request failed", {
        cause: new AggregateError([Object.assign(new Error("connection failed"), { code, syscall: "getaddrinfo" })]),
      })
      for (const error of [source, AgentTurnProtocol.deserializeError(AgentTurnProtocol.serializeError(source))]) {
        const result = MessageV2.fromError(error, { providerID: "any-provider" })
        expect(result).toMatchObject({ name: "APIError", data: { isRetryable: true } })
        expect(SessionRetry.retryable(result)).toBeDefined()
      }
    },
  )

  test.each(["ENOTFOUND", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_ABORTED"])(
    "does not retry nested %s despite an optimistic SDK retry flag",
    (code) => {
      const source = new APICallError({
        message: "fetch failed",
        url: "https://provider.invalid",
        requestBodyValues: {},
        isRetryable: true,
        cause: new TypeError("fetch failed", { cause: Object.assign(new Error("failure"), { code }) }),
      })
      for (const error of [source, AgentTurnProtocol.deserializeError(AgentTurnProtocol.serializeError(source))]) {
        expect(SessionRetry.retryable(MessageV2.fromError(error, { providerID: "any-provider" }))).toBeUndefined()
      }
    },
  )

  test.each([408, 429, 502, 503, 504])("recognizes HTTP %s without SDK retry metadata", (statusCode) => {
    const source = Object.assign(new Error("upstream unavailable"), {
      statusCode,
      responseHeaders: { "Retry-After": "2" },
    })
    const result = MessageV2.fromError(AgentTurnProtocol.deserializeError(AgentTurnProtocol.serializeError(source)), {
      providerID: "test",
    })
    expect(result).toMatchObject({ name: "APIError", data: { statusCode, responseHeaders: { "Retry-After": "2" } } })
    expect(SessionRetry.retryable(result)).toBeDefined()
  })

  test.each([400, 401, 403, 404, 422, 501, 505])("does not retry HTTP %s from a generic fetch error", (statusCode) => {
    const source = new APICallError({
      message: "fetch failed",
      url: "https://provider.invalid",
      requestBodyValues: {},
      statusCode,
    })
    expect(SessionRetry.retryable(MessageV2.fromError(source, { providerID: "test" }))).toBeUndefined()
  })

  test.each([
    { type: "error", error: { type: "overloaded_error", message: "busy" } },
    { type: "error", error: { type: "server_error", message: "busy" } },
  ])("recognizes structured stream overload without a code", (source) => {
    const error = AgentTurnProtocol.deserializeError(AgentTurnProtocol.serializeError(source))
    expect(SessionRetry.retryable(MessageV2.fromError(error, { providerID: "test" }))).toBeDefined()
  })

  test.each(["invalid_api_key", "invalid_request_error", "insufficient_quota"])(
    "does not retry a JSON %s error",
    (type) => {
      const source = new Error(
        JSON.stringify({ type: "error", code: "bad_request", error: { type, message: "rejected" } }),
      )
      expect(SessionRetry.retryable(MessageV2.fromError(source, { providerID: "test" }))).toBeUndefined()
    },
  )
  test("preserves structured provider recovery metadata", () => {
    const result = MessageV2.fromError(
      new ProviderAuthRecovery.Error({
        providerID: "openai-codex",
        failureCode: "token_invalidated",
        actionRequired: true,
        message: "Reconnect the provider.",
      }),
      { providerID: "openai-codex" },
    )

    expect(MessageV2.AuthError.isInstance(result)).toBe(true)
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      providerID: "openai-codex",
      failureCode: "token_invalidated",
      actionRequired: true,
      message: "Reconnect the provider.",
    })
  })

  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await Bun.sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID: "test" })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("converts Bun connection-refused errors to retryable APIError", () => {
    const error = new Error("Unable to connect. Is the computer able to access the url?")
    Object.assign(error, { code: "ConnectionRefused" })

    const result = MessageV2.fromError(error, { providerID: "test" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toBe(
      "Unable to connect. Is the computer able to access the url?",
    )
    expect((result as MessageV2.APIError).data.metadata?.code).toBe("ConnectionRefused")
  })

  test("converts unable-to-connect provider errors to retryable APIError even without a code", () => {
    const error = new Error("Unable to connect. Is the computer able to access the url?")

    const result = MessageV2.fromError(error, { providerID: "test" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result)).toBe("Unable to connect. Is the computer able to access the url?")
  })

  test("marks API call unable-to-connect errors retryable when provider did not", () => {
    const error = new APICallError({
      message: "Unable to connect. Is the computer able to access the url?",
      url: "https://api.example.test/v1/chat",
      requestBodyValues: {},
      isRetryable: false,
    })

    const result = MessageV2.fromError(error, { providerID: "test" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result)).toBe("Unable to connect. Is the computer able to access the url?")
  })

  test("preserves the requested model when the provider explicitly rejects it", () => {
    const error = new APICallError({
      message: "The requested model is not available",
      url: "https://api.example.test/v1/chat",
      requestBodyValues: { model: "model-retained" },
      statusCode: 404,
      responseBody: JSON.stringify({ error: { message: "model not found" } }),
      isRetryable: false,
    })

    const result = MessageV2.fromError(error, { providerID: "test", modelID: "model-retained" })

    expect(ProviderModelUnavailableError.isInstance(result)).toBe(true)
    expect(result).toMatchObject({
      data: { providerID: "test", modelID: "model-retained", reason: "rejected_by_provider" },
    })
  })

  test("converts protocol-rehydrated structured errors into retryable APIError", () => {
    const restored = AgentTurnProtocol.deserializeError(
      AgentTurnProtocol.serializeError({
        type: "server_error",
        code: "upstream_unavailable",
        message: "The upstream service is temporarily unavailable",
        statusCode: 503,
        isRetryable: true,
      }),
    )

    const result = MessageV2.fromError(restored, { providerID: "test" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.statusCode).toBe(503)
    expect(SessionRetry.retryable(result)).toBe("The upstream service is temporarily unavailable")
  })

  test("keeps unknown errors unknown when no retry metadata survives", () => {
    const restored = AgentTurnProtocol.deserializeError(
      AgentTurnProtocol.serializeError({ type: "unknown_provider_error", message: "boom" }),
    )

    const result = MessageV2.fromError(restored, { providerID: "test" })

    expect(result.name).toBe("UnknownError")
  })
  test("classifies agent worker exits as retryable", () => {
    const workerCrash = new Error("Agent worker exited (SIGTERM)")
    const result = MessageV2.fromError(workerCrash, { providerID: "test" })

    expect(result.name).toBe("UnknownError")
    expect(SessionRetry.retryable(result)).toBe("Agent worker restarted")
  })

  test("does not classify unrelated errors as worker exits", () => {
    const unknown = new Error("Provider timeout")
    const result = MessageV2.fromError(unknown, { providerID: "test" })

    expect(SessionRetry.retryable(result)).toBeUndefined()
  })
})

test("a timeout wrapper cannot hide a permanent certificate cause", () => {
  const error = Object.assign(new DOMException("timeout", "TimeoutError"), { cause: { code: "CERT_HAS_EXPIRED" } })
  const parsed = MessageV2.fromError(error, { providerID: "test" })
  expect(SessionRetry.retryable(parsed)).toBeUndefined()
})
