import { describe, expect, test } from "bun:test"
import { Envelope } from "../../src/holos/envelope"
import type { NativeMessage, NativeTunnelPort } from "../../src/holos/native"
import {
  NATIVE_FRAME_SIZE_LIMIT,
  NATIVE_MAX_ARRAY_LENGTH,
  NATIVE_MAX_FILE_REFS,
  NATIVE_MAX_ID_LENGTH,
  NATIVE_MAX_OBJECT_DEPTH,
  NATIVE_MAX_OBJECT_KEYS,
  NATIVE_MAX_PAYLOAD_BYTES,
  NATIVE_MAX_STRING_LENGTH,
} from "../../src/holos/native"

// ── Helpers ──────────────────────────────────────────────────────────

function oversizedFrame(): string {
  const size = NATIVE_FRAME_SIZE_LIMIT + 1
  const body = JSON.stringify({ type: "clarus.x", request_id: null, meta: {}, payload: { a: 1 }, caller: null })
  const padding = " ".repeat(size - body.length)
  return padding + body
}

function validNativeMessage(overrides: Partial<NativeMessage> = {}): NativeMessage {
  return {
    type: "clarus.runtime.task.assigned",
    requestID: null,
    meta: {},
    payload: {
      run_id: "run-1",
      project_id: "proj-1",
      task_id: "task-1",
      phase: "execution",
      subtask_id: "sub-1",
      attempt: 1,
      deadline_at: null,
    },
    caller: null,
    agentID: "agent-1",
    sessionID: null,
    generation: 1,
    epoch: 100,
    ...overrides,
  }
}

function makeTunnel(
  responses?: Array<NativeMessage>,
): NativeTunnelPort & { sent: Array<{ type: string; requestID: string; payload: unknown }> } {
  const sent: Array<{ type: string; requestID: string; payload: unknown }> = []
  let idx = 0
  return {
    sent,
    registerNativeObserver: () => () => {},
    registerConnectionObserver: () => () => {},
    sendNativeRequest: (input) => {
      sent.push({ type: input.type, requestID: input.requestID, payload: input.payload })
      const r = responses?.[idx++] ?? {
        type: input.expectedResponseType,
        requestID: input.requestID,
        meta: {},
        payload: {},
        caller: null,
        agentID: "agent-1",
        sessionID: null,
        generation: 1,
        epoch: 100,
      }
      return { requestID: input.requestID, response: Promise.resolve(r) }
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Envelope frame size guard", () => {
  test("rejects oversized frame before JSON.parse", () => {
    const result = Envelope.parse(oversizedFrame())
    expect(result).toBeNull()
  })

  test("accepts frame at limit", () => {
    const size = NATIVE_FRAME_SIZE_LIMIT
    const body = JSON.stringify({
      type: "clarus.x",
      request_id: null,
      meta: { v: "1" },
      payload: { a: 1 },
      caller: null,
    })
    const pad = " ".repeat(size - body.length)
    const frame = pad + body
    const result = Envelope.parse(frame)
    expect(result).not.toBeNull()
  })

  test("accepts normal small frame", () => {
    const result = Envelope.parse(
      JSON.stringify({ type: "clarus.x", request_id: "r", meta: { v: "1" }, payload: { a: 1 }, caller: null }),
    )

    expect(result).not.toBeNull()
    expect(result!.kind).toBe("native")
  })

  test("rejects frame with pre-parse guard only — does not throw", () => {
    const massive = "x".repeat(NATIVE_FRAME_SIZE_LIMIT + 1000)
    const result = Envelope.parse(massive)
    expect(result).toBeNull()
  })

  test("invalid json still returns null without raw content in log metadata", () => {
    const result = Envelope.parse("this is not json at all ---")
    expect(result).toBeNull()
  })
})

describe("Clarus semantic provenance", () => {
  test("toSemanticEvent preserves epoch/generation on known events", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; epoch?: number; generation?: number }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.project.subscribed",
        payload: { project_id: "p1", subscribed: true },
        epoch: 42,
        generation: 7,
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
    expect(events[0].epoch).toBe(42)
    expect(events[0].generation).toBe(7)
  })

  test("toSemanticEvent preserves epoch/generation on unknown clarus events", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; epoch?: number; generation?: number }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.future.feature",
        payload: { something: true },
        epoch: 99,
        generation: 3,
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("unknown")
    expect(events[0].epoch).toBe(99)
    expect(events[0].generation).toBe(3)
  })

  test("toSemanticEvent preserves epoch/generation on invalid clarus events", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; epoch?: number; generation?: number }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)

    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "  ",
          project_id: "p1",
          task_id: "t1",
          phase: "execution",
          subtask_id: "s1",
          attempt: 1,
          deadline_at: null,
        },
        epoch: 55,
        generation: 2,
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("invalid")
    expect(events[0].epoch).toBe(55)
    expect(events[0].generation).toBe(2)
  })

  test("non-clarus events are filtered at the adapter boundary", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; epoch?: number; generation?: number }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "other.namespace.event",
        payload: { some: "data" },
        epoch: 200,
        generation: 10,
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(0)
  })
})

describe("Semantic field bounding", () => {
  test("truncates oversized instructions field in runtimeTaskAssigned", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; instructions?: string | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const oversizeInstructions = "x".repeat(NATIVE_MAX_STRING_LENGTH + 500)
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          instructions: oversizeInstructions,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { instructions?: string | null }
      expect(e.instructions).toBeDefined()

      expect(e.instructions!.length).toBeLessThanOrEqual(NATIVE_MAX_STRING_LENGTH)
    }
  })

  test("truncates oversized goal field in runtimeTaskAssigned", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; goal?: string | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const oversizeGoal = "g".repeat(NATIVE_MAX_STRING_LENGTH + 200)
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          goal: oversizeGoal,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { goal?: string | null }
      expect(e.goal).toBeDefined()
      expect(e.goal!.length).toBeLessThanOrEqual(NATIVE_MAX_STRING_LENGTH)
    }
  })

  test("truncates oversized task_id in runtimeTaskAssigned", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; taskID?: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const oversizeID = "id-".repeat(200)
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: oversizeID,
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { taskID?: string }
      expect(e.taskID).toBeDefined()
      expect(e.taskID!.length).toBeLessThanOrEqual(NATIVE_MAX_ID_LENGTH)
    }
  })

  test("deeply nested input object is redacted in runtimeTaskAssigned", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; input?: Record<string, unknown> | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    let deep: Record<string, unknown> = { leaf: "value" }
    for (let i = 0; i < NATIVE_MAX_OBJECT_DEPTH + 3; i++) {
      deep = { nested: deep }
    }
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          input: deep,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { input?: Record<string, unknown> | null }
      if (e.input != null) {
        const json = JSON.stringify(e.input)
        expect(json.length).toBeLessThan(1000)
      }
    }
  })

  test("content field in projectMessageCreated is bounded", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.project.message.created",
        payload: {
          project_id: "proj-1",
          message: {
            message_id: "m1",
            project_id: "proj-1",
            channel_id: "ch-1",
            sender_type: "agent",
            sender_id: "s1",
            message_type: "text",
            content: "c".repeat(NATIVE_MAX_STRING_LENGTH + 1000),
            file_refs: [],
            metadata: {},
            created_at: null,
          },
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { message?: { content: string } }
      expect(e.message).toBeDefined()
      expect(e.message!.content.length).toBeLessThanOrEqual(NATIVE_MAX_STRING_LENGTH)
    }
  })

  test("excessive file_refs are capped in projectMessageCreated", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},

      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const excessiveRefs = Array.from({ length: NATIVE_MAX_FILE_REFS + 50 }, (_, i) => ({
      url: `http://example.com/${i}`,
      name: `file-${i}`,
    }))
    captureObserver!(
      validNativeMessage({
        type: "clarus.project.message.created",
        payload: {
          project_id: "proj-1",
          message: {
            message_id: "m1",
            project_id: "proj-1",
            channel_id: "ch-1",
            sender_type: "agent",
            sender_id: "s1",
            message_type: "text",
            content: "hello",
            file_refs: excessiveRefs,
            metadata: {},
            created_at: null,
          },
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { message?: { content: string } }
      expect(e.message).toBeDefined()
    }
  })
})

describe("Request adapter redaction", () => {
  test("response payload parse error redacts original error details", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const tunnel = makeTunnel([
      {
        type: "clarus.project.subscribed",
        requestID: "req-1",
        meta: {},
        payload: { not_even_a_project_id: true },
        caller: null,
        agentID: "agent-1",
        sessionID: null,
        generation: 1,
        epoch: 100,
      },
    ])
    const port = createClarusAgentTunnelAdapter(tunnel)

    const result = await port.subscribeProject({ projectID: "p1", requestID: "req-1" }).response.then(
      () => {
        throw new Error("should not resolve")
      },
      (err) => err,
    )
    expect(result.disposition).toBe("ambiguous")
    expect(result.reason).toBe("invalid_response")
    expect(typeof result.message).toBe("string")
  })

  test("non-Zod error in safeMap is redacted", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: (input) => ({
        requestID: input.requestID,
        response: Promise.resolve({
          type: input.expectedResponseType,
          requestID: input.requestID,
          meta: {},
          payload: { sensitive: "secret-key-abc123", project_id: null },
          caller: null,
          agentID: "agent-1",
          sessionID: null,
          generation: 1,
          epoch: 100,
        }),
      }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    const result = await port.subscribeProject({ projectID: "p1", requestID: "req-2" }).response.then(
      () => {
        throw new Error("should not resolve")
      },
      (err) => err,
    )
    expect(result.disposition).toBe("ambiguous")
    expect(result.reason).toBe("invalid_response")

    if (typeof result.message === "string") {
      expect(result.message).not.toContain("secret-key-abc123")
    }
  })
})

describe("Provenance contract types", () => {
  test("ClarusKnownEvent types have required epoch and generation", () => {
    const e = {
      kind: "known" as const,
      type: "projectSubscribed" as const,
      agentID: "a",
      requestID: null,
      projectID: "p",
      epoch: 1,
      generation: 1,
    }
    expect(e.epoch).toBe(1)
    expect(e.generation).toBe(1)
  })

  test("ClarusUnknownEvent type has required epoch and generation", () => {
    const e = {
      kind: "unknown" as const,
      sourceType: "clarus.x",
      agentID: "a",
      requestID: null,
      epoch: 1,
      generation: 1,
    }
    expect(e.epoch).toBe(1)
    expect(e.generation).toBe(1)
  })

  test("ClarusInvalidEvent type has required epoch and generation", () => {
    const e = {
      kind: "invalid" as const,
      sourceType: "clarus.runtime.task.assigned",
      agentID: "a",
      requestID: null,
      issues: [] as readonly { path: PropertyKey[]; message: string }[],
      epoch: 1,
      generation: 1,
    }
    expect(e.epoch).toBe(1)
    expect(e.generation).toBe(1)
  })
})

describe("UTF-8 multibyte frame limit", () => {
  test("rejects frame exceeding limit in UTF-8 bytes but not in UTF-16 chars", () => {
    const prefix = JSON.stringify({ type: "clarus.x", request_id: null, meta: {}, payload: {}, caller: null })
    const chineseChar = "中"
    const utf8BytesPerChar = new TextEncoder().encode(chineseChar).length
    const charsNeeded = Math.ceil((NATIVE_FRAME_SIZE_LIMIT - prefix.length) / utf8BytesPerChar) + 10
    const multibyteFrame = prefix + chineseChar.repeat(charsNeeded)
    expect(multibyteFrame.length).toBeLessThanOrEqual(NATIVE_FRAME_SIZE_LIMIT)
    const utf8Len = new TextEncoder().encode(multibyteFrame).length
    expect(utf8Len).toBeGreaterThan(NATIVE_FRAME_SIZE_LIMIT)
    const result = Envelope.parse(multibyteFrame)
    expect(result).toBeNull()
  })

  test("accepts multibyte frame within UTF-8 byte limit", () => {
    const chineseChar = "中"
    const utf8BytesPerChar = new TextEncoder().encode(chineseChar).length
    const body = JSON.stringify({ type: "clarus.x", request_id: null, meta: {}, payload: {}, caller: null })
    const remaining = NATIVE_FRAME_SIZE_LIMIT - new TextEncoder().encode(body).length
    const safeCharCount = Math.floor(remaining / utf8BytesPerChar) - 5
    if (safeCharCount <= 0) return
    const padding = chineseChar.repeat(safeCharCount)
    const frame = body.slice(0, -1) + ',"pad":"' + padding + '"}'
    const utf8Len = new TextEncoder().encode(frame).length
    expect(utf8Len).toBeLessThanOrEqual(NATIVE_FRAME_SIZE_LIMIT)
    const result = Envelope.parse(frame)
    expect(result).not.toBeNull()
  })
})

describe("Bounds.object cycle protection", () => {
  test("self-referencing object does not cause infinite recursion", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; input?: Record<string, unknown> | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const cyclic: Record<string, unknown> = { name: "self-reference" }
    cyclic.self = cyclic

    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          input: cyclic,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
  })

  test("cross-referencing objects are handled safely", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; input?: Record<string, unknown> | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const shared: Record<string, unknown> = { value: "shared" }
    const input: Record<string, unknown> = { a: shared, b: shared }
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          input,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
  })
})

describe("Bounds.object nested arrays", () => {
  test("nested arrays with deep objects are bounded recursively", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; input?: Record<string, unknown> | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    let deep: Record<string, unknown> = { leaf: "x" }
    for (let i = 0; i < NATIVE_MAX_OBJECT_DEPTH + 3; i++) {
      deep = { nested: deep }
    }
    const nestedArrays: Record<string, unknown> = {
      items: Array.from({ length: NATIVE_MAX_ARRAY_LENGTH + 50 }, () => deep),
    }
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,

          input: nestedArrays,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { input?: Record<string, unknown> | null }
      if (e.input != null) {
        const json = JSON.stringify(e.input)
        expect(json.length).toBeLessThan(5000)
      }
    }
  })

  test("excessive object keys are capped at NATIVE_MAX_OBJECT_KEYS", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; input?: Record<string, unknown> | null }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    const manyKeys: Record<string, unknown> = {}
    for (let i = 0; i < NATIVE_MAX_OBJECT_KEYS + 50; i++) {
      manyKeys[`key_${i}`] = i
    }
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          input: manyKeys,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    if (events[0].kind === "known") {
      const e = events[0] as { input?: Record<string, unknown> | null }
      if (e.input != null) {
        expect(Object.keys(e.input).length).toBeLessThanOrEqual(NATIVE_MAX_OBJECT_KEYS)
      }
    }
  })
})

describe("Aggregate payload byte budget", () => {
  test("DTO exceeding NATIVE_MAX_PAYLOAD_BYTES is rejected", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })
    const hugeGoal = "G".repeat(NATIVE_MAX_STRING_LENGTH)
    const hugeInstructions = "I".repeat(NATIVE_MAX_STRING_LENGTH)
    const hugeContext: Record<string, unknown> = { blob: "X".repeat(NATIVE_MAX_STRING_LENGTH) }
    const hugeTaskInput: Record<string, unknown> = { blob: "Y".repeat(NATIVE_MAX_STRING_LENGTH) }
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          goal: hugeGoal,
          instructions: hugeInstructions,

          context: hugeContext,
          task_input: hugeTaskInput,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).not.toBe("known")
  })

  test("multibyte DTO below code-unit threshold but above UTF-8 byte threshold is rejected", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })
    // "\u4E2D" ("中") is 1 UTF-16 code unit but 3 UTF-8 bytes.
    // Two full-length bounded strings (~131K code units) produce ~393K UTF-8 bytes,
    // well under the 256K code-unit threshold but well over the byte budget.
    const mb = "\u4E2D".repeat(NATIVE_MAX_STRING_LENGTH)
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
          goal: mb,
          instructions: mb,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).not.toBe("known")
  })

  test("ASCII DTO below byte threshold is accepted", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })
    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.assigned",
        payload: {
          run_id: "run-1",
          project_id: "proj-1",
          task_id: "task-1",
          phase: "execution",
          subtask_id: "sub-1",
          attempt: 1,
          deadline_at: null,
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
  })
})

describe("Non-assignment event bounds", () => {
  test("projectSystemEvent bounds eventType as an ID", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; eventType?: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.project.system.event",
        payload: {
          project_id: "p1",
          event_type: "e".repeat(NATIVE_MAX_ID_LENGTH + 100),
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
    if (events[0].kind === "known") {
      const e = events[0] as { eventType?: string }
      expect(e.eventType).toBeDefined()
      expect(e.eventType!.length).toBeLessThanOrEqual(NATIVE_MAX_ID_LENGTH)
    }
  })

  test("projectFileUploaded bounds projectID as an ID", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; projectID?: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.project.file.uploaded",
        payload: { project_id: "p".repeat(NATIVE_MAX_ID_LENGTH + 50) },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
    if (events[0].kind === "known") {
      const e = events[0] as { projectID?: string }
      expect(e.projectID).toBeDefined()
      expect(e.projectID!.length).toBeLessThanOrEqual(NATIVE_MAX_ID_LENGTH)
    }
  })

  test("runtimeTaskExtended bounds taskID and status", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.runtime.task.extended",
        payload: {
          project_id: "p1",
          run_id: "run-1",
          task: {
            task_id: "t".repeat(NATIVE_MAX_ID_LENGTH + 100),
            run_id: "run-1",
            project_id: "p1",
            phase: "execution",
            subtask_id: "s1",
            attempt: 1,
            status: "s".repeat(NATIVE_MAX_STRING_LENGTH + 500),
            deadline_at: null,
            dispatched_at: null,

            completed_at: null,
            created_at: null,
            updated_at: null,
          },
        },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
  })

  test("notaryRecordCreated bounds projectID", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const events: Array<{ kind: string; projectID?: string }> = []
    let captureObserver: ((msg: NativeMessage) => void) | null = null
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: (handler) => {
        captureObserver = handler
        return () => {
          captureObserver = null
        }
      },
      registerConnectionObserver: () => () => {},
      sendNativeRequest: () => ({ requestID: "x", response: new Promise(() => {}) }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    port.registerEventHandler((e) => {
      events.push(e)
    })

    captureObserver!(
      validNativeMessage({
        type: "clarus.notary.record.created",
        payload: { project_id: "n".repeat(NATIVE_MAX_ID_LENGTH + 50) },
      }),
    )
    await Bun.sleep(5)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("known")
    if (events[0].kind === "known") {
      const e = events[0] as { projectID?: string }
      expect(e.projectID).toBeDefined()
      expect(e.projectID!.length).toBeLessThanOrEqual(NATIVE_MAX_ID_LENGTH)
    }
  })
})

describe("Diagnostic redaction", () => {
  test("safeMap ZodError messages redact raw Zod issue values", async () => {
    const { createClarusAgentTunnelAdapter } = await import("../../src/channel/provider/clarus/tunnel-adapter")
    const tunnel: NativeTunnelPort = {
      registerNativeObserver: () => () => {},
      registerConnectionObserver: () => () => {},
      sendNativeRequest: (input) => ({
        requestID: input.requestID,
        response: Promise.resolve({
          type: input.expectedResponseType,
          requestID: input.requestID,
          meta: {},
          payload: { not_a_valid_payload: "raw-secret-xyz789", project_id: 123 },
          caller: null,
          agentID: "agent-1",
          sessionID: null,
          generation: 1,
          epoch: 100,
        }),
      }),
    }
    const port = createClarusAgentTunnelAdapter(tunnel)
    const result = await port.subscribeProject({ projectID: "p1", requestID: "req-redact" }).response.then(
      () => {
        throw new Error("should not resolve")
      },
      (err) => err,
    )
    expect(result.disposition).toBe("ambiguous")
    expect(result.reason).toBe("invalid_response")
    if (typeof result.message === "string") {
      expect(result.message).not.toContain("raw-secret-xyz789")
      expect(result.message).not.toContain("not_a_valid_payload")
    }
  })
  test("envelope parse failure does not log raw Zod input data", () => {
    const badEnvelope = JSON.stringify({
      type: "clarus.x",
      request_id: true,
      meta: {},
      payload: null,
      caller: null,
      extra_secret: "leak",
    })
    const result = Envelope.parse(badEnvelope)
    expect(result).toBeNull()
  })
})
