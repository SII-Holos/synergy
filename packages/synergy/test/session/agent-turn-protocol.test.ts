import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"

describe("AgentTurnProtocol", () => {
  test("accepts a request at the configured byte boundary and rejects a larger request", () => {
    const base = {
      type: "run" as const,
      requestId: "turn_test",
      scope: {
        type: "home" as const,
        id: "home",
        directory: "/tmp/home",
        worktree: "/tmp/home",
      },
      input: {
        sessionID: "ses_test",
        messages: [],
      },
    }
    const baseBytes = AgentTurnProtocol.byteLength(base)
    const paddingOverhead = AgentTurnProtocol.byteLength({ ...base, padding: "" }) - baseBytes
    const accepted = {
      ...base,
      padding: "x".repeat(AgentTurnProtocol.REQUEST_MAX_BYTES - baseBytes - paddingOverhead),
    }

    expect(() => AgentTurnProtocol.assertRequestBound(accepted)).not.toThrow()
    expect(() => AgentTurnProtocol.assertRequestBound({ ...accepted, padding: `${accepted.padding}xx` })).toThrow(
      "Agent turn request exceeded",
    )
  })

  test("bounds worker event frames independently from the total stream", () => {
    const frame = {
      type: "events" as const,
      requestId: "turn_test",
      sequence: 1,
      events: [{ type: "text-delta", id: "text_1", text: "ok" }],
    }

    expect(() => AgentTurnProtocol.assertEventFrameBound(frame)).not.toThrow()
    expect(() =>
      AgentTurnProtocol.assertEventFrameBound({
        ...frame,
        events: [{ type: "text-delta", id: "text_1", text: "x".repeat(AgentTurnProtocol.EVENT_MAX_BYTES) }],
      }),
    ).toThrow("Agent turn event frame exceeded")
  })

  test("counts binary payload bytes instead of only typed-array metadata", () => {
    expect(AgentTurnProtocol.byteLength({ payload: new Uint8Array(1024) })).toBeGreaterThan(1024)
  })

  test("serializes turn snapshots and bounds every transfer chunk", () => {
    const envelope = {
      scope: {
        type: "home" as const,
        id: "home" as const,
        directory: "/tmp/home",
        worktree: "/tmp/home",
      },
      input: {
        user: { id: "msg_user" },
        sessionID: "ses_test",
        model: { id: "model", providerID: "provider" },
        agent: { name: "synergy" },
        system: ["x".repeat(AgentTurnProtocol.REQUEST_CHUNK_BYTES + 64)],
        messages: [],
        toolDefinitions: [],
        prepared: {
          system: [],
          baseSystemLength: 0,
          provider: { options: {} },
          params: { options: {} },
        },
      },
    }
    const payload = AgentTurnProtocol.serializeTurn(envelope)
    const first = payload.subarray(0, AgentTurnProtocol.REQUEST_CHUNK_BYTES)
    const second = payload.subarray(AgentTurnProtocol.REQUEST_CHUNK_BYTES)

    expect(() =>
      AgentTurnProtocol.parseHostToWorker({
        type: "run-chunk",
        requestId: "turn",
        index: 0,
        data: first,
      }),
    ).not.toThrow()
    expect(second.byteLength).toBeGreaterThan(0)
    expect(AgentTurnProtocol.deserializeTurn(payload)).toEqual(envelope)
    expect(() =>
      AgentTurnProtocol.parseHostToWorker({
        type: "run-chunk",
        requestId: "turn",
        index: 0,
        data: new Uint8Array(AgentTurnProtocol.REQUEST_CHUNK_BYTES + 1),
      }),
    ).toThrow()
  })

  test("validates home and project runtime Scope snapshots", () => {
    const input = {
      user: { id: "msg_user" },
      sessionID: "ses_test",
      model: { id: "model", providerID: "provider" },
      agent: { name: "synergy" },
      system: [],
      messages: [],
      toolDefinitions: [],
      prepared: {
        system: [],
        baseSystemLength: 0,
        provider: { options: {} },
        params: { options: {} },
      },
    }

    expect(
      AgentTurnProtocol.TurnEnvelopeSchema.safeParse({
        scope: { type: "home", id: "home", directory: "/tmp/home", worktree: "/tmp/home" },
        input,
      }).success,
    ).toBe(true)
    expect(
      AgentTurnProtocol.TurnEnvelopeSchema.safeParse({
        scope: {
          type: "project",
          id: "scope_test",
          directory: "/tmp/project",
          worktree: "/tmp/project",
          sandboxes: [],
          time: { created: 1, updated: 2 },
        },
        input,
      }).success,
    ).toBe(true)
    expect(
      AgentTurnProtocol.TurnEnvelopeSchema.safeParse({
        scope: { type: "project", id: "scope_test", directory: "/tmp/project", worktree: "/tmp/project" },
        input,
      }).success,
    ).toBe(false)
  })

  test("serializes errors without losing their stable identity", () => {
    const source = Object.assign(new Error("provider failed"), {
      name: "ProviderFailure",
      code: "provider_unavailable",
    })
    const serialized = AgentTurnProtocol.serializeError(source)
    const restored = AgentTurnProtocol.deserializeError(serialized)

    expect(serialized).toMatchObject({
      name: "ProviderFailure",
      message: "provider failed",
      code: "provider_unavailable",
    })
    expect(restored).toBeInstanceOf(Error)
    expect(restored.name).toBe("ProviderFailure")
    expect(restored.message).toBe("provider failed")
    expect(restored.code).toBe("provider_unavailable")
  })

  test("preserves provider retry metadata and structured domain error data", () => {
    const provider = new APICallError({
      message: "rate limited",
      url: "https://provider.invalid",
      requestBodyValues: { secret: "not transferred" },
      statusCode: 429,
      responseHeaders: { "retry-after": "3" },
      responseBody: '{"error":"slow down"}',
      isRetryable: true,
      data: { category: "quota" },
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET", syscall: "read" }),
    })
    const restoredProvider = AgentTurnProtocol.deserializeError(AgentTurnProtocol.serializeError(provider))
    const domain = Object.assign(new Error("relogin"), {
      name: "ProviderAuthRecoveryError",
      data: { providerID: "provider", failureCode: "expired", actionRequired: true, message: "relogin" },
    })
    const restoredDomain = AgentTurnProtocol.deserializeError(AgentTurnProtocol.serializeError(domain)) as Error & {
      data?: unknown
    }

    expect(APICallError.isInstance(restoredProvider)).toBe(true)
    expect(restoredProvider).toMatchObject({
      statusCode: 429,
      responseHeaders: { "retry-after": "3" },
      responseBody: '{"error":"slow down"}',
      isRetryable: true,
      data: { category: "quota" },
    })
    expect((restoredProvider as APICallError).requestBodyValues).toEqual({})
    expect((restoredProvider.cause as Error & { code?: string }).code).toBe("ECONNRESET")
    expect(restoredDomain).toMatchObject({
      name: "ProviderAuthRecoveryError",
      data: { providerID: "provider", failureCode: "expired", actionRequired: true, message: "relogin" },
    })
  })

  test("rehydrates cancellation errors as DOMException", () => {
    const restored = AgentTurnProtocol.deserializeError(
      AgentTurnProtocol.serializeError(new DOMException("cancelled", "AbortError")),
    )

    expect(restored).toBeInstanceOf(DOMException)
    expect(restored.name).toBe("AbortError")
  })

  test("preserves structured errors embedded in stream events", () => {
    const source = new APICallError({
      message: "provider unavailable",
      url: "https://provider.invalid",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    })
    const [decoded] = AgentTurnProtocol.decodeEvents(
      AgentTurnProtocol.encodeEvents([{ type: "error", error: source }]),
    ) as Array<{ type: string; error: Error }>

    expect(decoded.type).toBe("error")
    expect(APICallError.isInstance(decoded.error)).toBe(true)
    expect(decoded.error).toMatchObject({ statusCode: 503, isRetryable: true })
  })

  test("rejects unknown protocol fields and invalid frame counters", () => {
    expect(() =>
      AgentTurnProtocol.parseHostToWorker({
        type: "ack",
        requestId: "turn",
        sequence: -1,
      }),
    ).toThrow()
    expect(() =>
      AgentTurnProtocol.parseWorkerToHost({
        type: "pong",
        unexpected: true,
      }),
    ).toThrow()
  })

  test("requires the Control Plane-prepared provider request plan", () => {
    expect(
      AgentTurnProtocol.TurnInputSchema.safeParse({
        user: { id: "msg_user" },
        sessionID: "ses_test",
        model: { id: "model", providerID: "provider" },
        agent: { name: "synergy" },
        system: [],
        messages: [],
        toolDefinitions: [],
      }).success,
    ).toBe(false)
  })

  test("rejects executable or undeclared Control Plane fields", () => {
    expect(
      AgentTurnProtocol.TurnInputSchema.safeParse({
        user: { id: "msg_user" },
        sessionID: "ses_test",
        model: { id: "model", providerID: "provider" },
        agent: { name: "synergy" },
        system: [],
        messages: [],
        toolDefinitions: [],
        executionTools: { bash: { execute() {} } },
        prepared: {
          system: [],
          baseSystemLength: 0,
          provider: { options: {} },
          params: { options: {} },
        },
      }).success,
    ).toBe(false)
  })
})
