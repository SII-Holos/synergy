import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { ClarusRuntime } from "../../src/clarus/runtime"
import type { SendProjectMessageResult } from "../../src/clarus/runtime"
import { ClarusBindingStore } from "../../src/clarus/binding"
import { ClarusOutbox } from "../../src/clarus/outbox"
import type {
  ClarusAgentTunnelPort,
  ClarusEventHandler,
  ClarusRequestResult,
  ProjectMessageCreatedEvent,
  SendProjectMessageInput,
} from "../../src/clarus/agent-tunnel-port"
import type { HolosConnectionEvent } from "../../src/holos/native"
import type { ClarusRestPort } from "../../src/clarus/rest-port"

let AGENT_ID = "ob_agent"
let PROJECT_ID = "ob_project"
let EPOCH = 1
let GENERATION = 1

// ── Controllable Fake Port ────────────────────────────────────────────

type SendMessageBehavior =
  | { kind: "success"; messageId?: string; senderId?: string; delayMs?: number }
  | { kind: "reject_sync"; code: string; message: string }
  | { kind: "reject_async"; reason: string; message?: string; delayMs?: number }
  | { kind: "wrong_requestID"; returnedID: string }

class ControllableClarusPort implements ClarusAgentTunnelPort {
  readonly eventHandlers = new Set<ClarusEventHandler>()
  readonly connectionHandlers = new Set<(event: HolosConnectionEvent) => void | Promise<void>>()
  sendMessageCalls: SendProjectMessageInput[] = []
  sendMessageBehavior: SendMessageBehavior = { kind: "success" }

  registerEventHandler(handler: ClarusEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }
  registerConnectionHandler(handler: (event: HolosConnectionEvent) => void | Promise<void>): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  async connect(agentID = AGENT_ID, generation = GENERATION, epoch = EPOCH): Promise<void> {
    const event: HolosConnectionEvent = {
      type: "connected",
      agentID,
      sessionID: `ses-${generation}`,
      generation,
      epoch,
    }
    for (const handler of this.connectionHandlers) await handler(event)
  }

  sendProjectMessage(input: SendProjectMessageInput): ClarusRequestResult<ProjectMessageCreatedEvent> {
    this.sendMessageCalls.push(input)
    const behavior = this.sendMessageBehavior

    if (behavior.kind === "reject_sync") {
      throw Object.assign(new Error(behavior.message), {
        disposition: "rejected",
        requestID: input.requestID,
        code: behavior.code,
      })
    }

    if (behavior.kind === "wrong_requestID") {
      return { requestID: behavior.returnedID, response: new Promise(() => {}) }
    }

    const requestID = input.requestID
    return {
      requestID,
      response: new Promise((resolve, reject) => {
        if (behavior.kind === "reject_async") {
          const delay = behavior.delayMs ?? 1
          setTimeout(() => {
            reject(
              Object.assign(new Error(behavior.message ?? behavior.reason), {
                disposition: "ambiguous",
                requestID: input.requestID,
                reason: behavior.reason as "timeout",
              }),
            )
          }, delay)
          return
        }

        const messageId = behavior.messageId ?? `srv-msg-${requestID}`
        const senderId = behavior.senderId ?? AGENT_ID
        const delay = behavior.delayMs ?? 1

        setTimeout(() => {
          resolve({
            kind: "known",
            type: "projectMessageCreated",
            agentID: AGENT_ID,
            requestID,
            projectID: input.projectID,
            message: { messageID: messageId, senderID: senderId, content: input.content },
            epoch: EPOCH,
            generation: GENERATION,
          })
        }, delay)
      }),
    }
  }

  subscribeProject(_input: { requestID: string; projectID: string }): ClarusRequestResult<never> {
    return { requestID: _input.requestID, response: new Promise(() => {}) }
  }
  unsubscribeProject(_input: { requestID: string; projectID: string }): ClarusRequestResult<never> {
    return { requestID: _input.requestID, response: new Promise(() => {}) }
  }
  extendTask(_input: { requestID: string; runID: string }): ClarusRequestResult<never> {
    return { requestID: _input.requestID, response: new Promise(() => {}) }
  }
  recordTaskResult(_input: Record<string, unknown>): ClarusRequestResult<never> {
    return { requestID: (_input as { requestID: string }).requestID, response: new Promise(() => {}) }
  }
}

// ── Dummy REST Port ────────────────────────────────────────────────────

class DummyRest implements ClarusRestPort.Interface {
  private returnProject: boolean

  constructor(opts?: { returnProject?: boolean }) {
    this.returnProject = opts?.returnProject ?? true
  }

  async listProjects(_params: { status?: string; limit?: number; cursor?: string }) {
    if (!this.returnProject) return { projects: [], nextCursor: null }
    return {
      projects: [
        {
          projectId: PROJECT_ID,
          title: "Test Project",
          status: "active",
          role: "member",
          runtimeAgentId: AGENT_ID,
          updatedAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    }
  }
  async getProject(_params: { projectId: string }): Promise<ClarusRestPort.ProjectDetailDto> {
    throw new Error("not used")
  }
  async listMessages(_params: {
    projectId: string
    cursor?: string
    limit?: number
  }): Promise<{ messages: ClarusRestPort.MessageDto[]; nextCursor: string | null }> {
    return { messages: [], nextCursor: null }
  }
  async listUsers(_params: { query: string; limit?: number }) {
    return { users: [] }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function catchErr<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (e) {
    return e
  }
}

async function seedProject(scope: Awaited<ReturnType<Awaited<ReturnType<typeof tmpdir>>["scope"]>>): Promise<void> {
  await ScopeContext.provide({
    scope,
    fn: async () => {
      await ClarusBindingStore.ensureActive(AGENT_ID, PROJECT_ID)
    },
  })
}

function freshID(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `ob_${suffix}`
  PROJECT_ID = `proj_${suffix}`
  EPOCH = Math.floor(Math.random() * 100) + 1
  GENERATION = Math.floor(Math.random() * 100) + 1
})

afterEach(() => {
  ClarusRuntime.detach()
  ClarusRuntime.configureRest(null)
  ClarusRuntime.configureScheduler(null)
})

// ════════════════════════════════════════════════════════════════════════
// 1. Happy path
// ════════════════════════════════════════════════════════════════════════

describe("sendProjectMessage happy path", () => {
  test("one native call, no local fanout, server message ID returned", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    let result: SendProjectMessageResult
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        result = await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "Hello from outbound",
        })
      },
    })

    expect(result!.requestID).toBe(requestID)
    expect(result!.projectId).toBe(PROJECT_ID)
    expect(typeof result!.messageId).toBe("string")
    expect(result!.messageId.length).toBeGreaterThan(0)
    expect(result!.senderId).toBe(AGENT_ID)
    expect(result!.epoch).toBe(EPOCH)
    expect(result!.generation).toBe(GENERATION)

    // Exactly one native call
    expect(port.sendMessageCalls.length).toBe(1)
    expect(port.sendMessageCalls[0].requestID).toBe(requestID)
    expect(port.sendMessageCalls[0].projectID).toBe(PROJECT_ID)
    expect(port.sendMessageCalls[0].content).toBe("Hello from outbound")
  })

  test("preallocate-before-dispatch ordering: outbox is prepared before markDispatched is set", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "success", delayMs: 30 }

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "preallocate test",
        })
      },
    })

    // After completion, outbox must be acknowledged with correct ordering
    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("acknowledged")
    expect(record!.preparedAt).toBeGreaterThan(0)
    expect(record!.dispatchedAt).toBeGreaterThan(0)
    expect(record!.dispatchedAt! >= record!.preparedAt).toBe(true)
    expect(record!.acknowledgedAt).toBeGreaterThan(0)
    expect(record!.acknowledgedAt! >= record!.dispatchedAt!).toBe(true)
  })

  test("acknowledgedPayload stores server messageId and senderId", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "success", messageId: "custom-srv-msg", senderId: "custom-sender" }

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()

        const r = await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "ack payload test",
        })
        expect(r.messageId).toBe("custom-srv-msg")
        expect(r.senderId).toBe("custom-sender")
      },
    })

    const record = await ClarusOutbox.get(requestID)
    expect(record!.acknowledgedPayload).toBeDefined()
    expect((record!.acknowledgedPayload as Record<string, unknown>).messageId).toBe("custom-srv-msg")
    expect((record!.acknowledgedPayload as Record<string, unknown>).senderId).toBe("custom-sender")
  })

  test("userId stored in result and acknowledgedPayload", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    let result: SendProjectMessageResult
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        result = await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "with user",
          userId: "user-123",
        })
      },
    })

    expect(result!.userId).toBe("user-123")

    const record = await ClarusOutbox.get(requestID)
    expect(record!.userId).toBe("user-123")
    expect((record!.acknowledgedPayload as Record<string, unknown>).userId).toBe("user-123")
  })
})

// ════════════════════════════════════════════════════════════════════════
// 2. Transport identity validation
// ════════════════════════════════════════════════════════════════════════

describe("transport identity validation", () => {
  test("throws when not attached", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          await ClarusRuntime.sendProjectMessage({
            requestID: freshID("req"),
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("not attached")
  })

  test("throws when connected agent ID differs from input agentId", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect(AGENT_ID)
          await ClarusRuntime.sendProjectMessage({
            requestID: freshID("req"),
            agentId: "wrong-agent",
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("agent identity does not match")
  })

  test("throws when no transport is connected (detached after attach)", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          // No port.connect() — transport is attached but not connected
          await ClarusRuntime.sendProjectMessage({
            requestID: freshID("req"),
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("agent identity does not match")
  })
})

// ════════════════════════════════════════════════════════════════════════
// 3. Project binding validation
// ════════════════════════════════════════════════════════════════════════

describe("project binding validation", () => {
  test("throws for inactive project", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest({ returnProject: false })
    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          // Do NOT seed the project — no binding exists
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID: freshID("req"),
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("project is not active")
  })

  test("does NOT dispatch for inactive project — no outbox record created", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest({ returnProject: false })
    const requestID = freshID("req")

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    // No native call
    expect(port.sendMessageCalls.length).toBe(0)

    // No outbox record should exist (binding check is before preallocation)
    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// 4. Pre-dispatch rejection
// ════════════════════════════════════════════════════════════════════════

describe("pre-dispatch rejection", () => {
  test("synchronous rejection before dispatch marks outbox rejected", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "reject_sync", code: "RATE_LIMITED", message: "Too many requests" }

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("Too many requests")

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.dispatchedAt).toBeUndefined()
    expect(port.sendMessageCalls.length).toBe(1)
  })

  test("pre-dispatch adapter requestID mismatch marks ambiguous", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "wrong_requestID", returnedID: "different-id" }

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("ambiguous")
  })
})

// ════════════════════════════════════════════════════════════════════════
// 5. Post-dispatch ambiguity
// ════════════════════════════════════════════════════════════════════════

describe("post-dispatch ambiguity", () => {
  test("async timeout after dispatch marks outbox ambiguous", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "reject_async", reason: "timeout", delayMs: 10 }

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("ambiguous")
    expect(record!.dispatchedAt).toBeGreaterThan(0)
    expect(record!.acknowledgedAt).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// 6. Exact replay (no second dispatch)
// ════════════════════════════════════════════════════════════════════════

describe("exact replay", () => {
  test("terminal acknowledged replay returns stored result without second dispatch", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "success", messageId: "msg-first", senderId: "sender-first" }

    let first: SendProjectMessageResult
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        first = await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "original",
        })

        // Second call — exact replay within same scope context
        const second = await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "original",
        })

        expect(second.messageId).toBe("msg-first")
        expect(second.projectId).toBe(PROJECT_ID)
      },
    })

    expect(first!.messageId).toBe("msg-first")
    expect(port.sendMessageCalls.length).toBe(1)
  })

  test("terminal ambiguous replay throws", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "reject_async", reason: "timeout", delayMs: 10 }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "timeout",
          })
        },
      }),
    )

    // Second call
    const secondErr = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "timeout",
          })
        },
      }),
    )

    expect(secondErr).toBeInstanceOf(Error)
    expect(port.sendMessageCalls.length).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 7. Timeout clamping
// ════════════════════════════════════════════════════════════════════════

describe("timeout clamping", () => {
  test("timeout is clamped to 30s max", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "timeout clamp test",
          timeoutMs: 120_000,
        })
      },
    })

    expect(port.sendMessageCalls.length).toBe(1)
    expect(port.sendMessageCalls[0].timeoutMs).toBe(30_000)
  })

  test("default timeout is 30s when not specified", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "default timeout",
        })
      },
    })

    expect(port.sendMessageCalls[0].timeoutMs).toBe(30_000)
  })

  test("custom timeout under 30s is passed through", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "short timeout",
          timeoutMs: 5_000,
        })
      },
    })

    expect(port.sendMessageCalls[0].timeoutMs).toBe(5_000)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 8. messageType and fileRefs passthrough
// ════════════════════════════════════════════════════════════════════════

describe("messageType and fileRefs", () => {
  test("messageType is passed through to port call", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "typed message",
          messageType: "rich_text",
        })
      },
    })

    expect(port.sendMessageCalls[0].messageType).toBe("rich_text")
  })

  test("fileRefs are passed through to port call", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    const fileRefs = [{ name: "report.pdf", url: "https://example.com/report.pdf" }]

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "with files",
          fileRefs,
        })
      },
    })

    expect(port.sendMessageCalls[0].fileRefs).toEqual(fileRefs)
  })

  test("payload validation rejects oversized fileRefs", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    const oversizedRefs = Array.from({ length: 51 }, (_, i) => ({ name: `file_${i}` }))

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "too many refs",
            fileRefs: oversizedRefs,
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect(port.sendMessageCalls.length).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 9. Restart Outbox terminal readback
// ════════════════════════════════════════════════════════════════════════

describe("restart outbox terminal readback", () => {
  test("terminal outbox record survives detach/reattach and is readable", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const requestID = freshID("req")

    const port1 = new ControllableClarusPort()
    const rest = new DummyRest()

    port1.sendMessageBehavior = { kind: "success", messageId: "persisted-msg", senderId: "persisted-sender" }

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port1)
        await port1.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "persist me",
        })
      },
    })

    ClarusRuntime.detach()

    // Read back the outbox record directly
    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("acknowledged")
    expect(record!.acknowledgedPayload).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// 10. Non-terminal replay (collision guard)
// ════════════════════════════════════════════════════════════════════════

describe("terminal replay identity validation", () => {
  test("replaying a rejected record with different content now throws CLARUS_OUTBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "reject_sync", code: "ORIG_ERR", message: "original error" }

    const firstErr = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "first",
          })
        },
      }),
    )

    expect(firstErr).toBeInstanceOf(Error)

    // Replay with different content — identity mismatch now throws CLARUS_OUTBOX_COLLISION
    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "different",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error & { code?: string }).code).toBe("CLARUS_OUTBOX_COLLISION")
    expect(port.sendMessageCalls.length).toBe(1)
  })

  test("acknowledged replay with mismatched content throws CLARUS_OUTBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "success" }

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()
        await ClarusRuntime.sendProjectMessage({
          requestID,
          agentId: AGENT_ID,
          projectId: PROJECT_ID,
          content: "original",
        })
      },
    })

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "hijacked",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error & { code?: string }).code).toBe("CLARUS_OUTBOX_COLLISION")
  })

  test("ambiguous replay with mismatched projectId throws CLARUS_OUTBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "reject_async", reason: "timeout", delayMs: 10 }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "timeout",
          })
        },
      }),
    )

    const err = await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: "different-project",
            content: "timeout",
          })
        },
      }),
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error & { code?: string }).code).toBe("CLARUS_OUTBOX_COLLISION")
  })
})

// ════════════════════════════════════════════════════════════════════════
// 11. Concurrent duplicate dispatch deduplication
// ════════════════════════════════════════════════════════════════════════

describe("concurrent duplicate deduplication", () => {
  test("concurrent identical calls with same requestID result in exactly one native operation", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    // Slow response so both calls overlap
    port.sendMessageBehavior = { kind: "success", delayMs: 50, messageId: "dedup-msg", senderId: "dedup-sender" }

    const results: (SendProjectMessageResult | unknown)[] = []

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()

        const [a, b] = await Promise.all([
          ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "concurrent",
          }).then(
            (r) => results.push(r),
            (e) => results.push(e),
          ),
          ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "concurrent",
          }).then(
            (r) => results.push(r),
            (e) => results.push(e),
          ),
        ])
      },
    })

    expect(results.length).toBe(2)
    expect(port.sendMessageCalls.length).toBe(1)

    // Both results are the same SendProjectMessageResult
    const r0 = results[0] as SendProjectMessageResult
    const r1 = results[1] as SendProjectMessageResult
    expect(r0.messageId).toBe("dedup-msg")
    expect(r1.messageId).toBe("dedup-msg")
  })

  test("concurrent mismatched identity throws CLARUS_OUTBOX_COLLISION", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = { kind: "success", delayMs: 50 }

    const errs: unknown[] = []

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await seedProject(scope)
        ClarusRuntime.configureRest(rest)
        await ClarusRuntime.attach(port)
        await port.connect()

        await Promise.all([
          ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "legit",
          }).catch((e) => errs.push(e)),
          // Same requestID but different content => collision
          ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "hijack",
          }).catch((e) => errs.push(e)),
        ])
      },
    })

    // One rejected with CLARUS_OUTBOX_COLLISION, one succeeded
    const collisionErr = errs.find((e) => (e as Error & { code?: string })?.code === "CLARUS_OUTBOX_COLLISION")
    expect(collisionErr).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// 12. Native error redaction
// ════════════════════════════════════════════════════════════════════════

describe("native error redaction in Outbox", () => {
  test("error containing a bearer token is redacted in rejected outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    const fakeToken = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join(".")
    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "AUTH_ERR",
      message: `unauthorized: Bearer ${fakeToken}`,
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.errorCode).toBe("AUTH_ERR")
    expect(record!.errorMessage).toContain("Bearer [token redacted]")
    expect(record!.errorMessage).not.toContain("eyJ")
  })

  test("error containing a URL is redacted in rejected outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "FETCH_ERR",
      message: "fetch failed: https://api.internal.example.com/v2/projects/secret/endpoint?token=abc123",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.errorCode).toBe("FETCH_ERR")
    expect(record!.errorMessage).toContain("[URL redacted]")
    expect(record!.errorMessage).not.toContain("api.internal")
  })

  test("error containing newlines and control chars is collapsed in ambiguous outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_async",
      reason: "timeout",
      message: "timeout after\n\n30s\nwith\x00null\x1fchars",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("ambiguous")
    expect(record!.errorMessage).not.toContain("\n")
    expect(record!.errorMessage).not.toContain("\x00")
  })

  test("error message is bounded to 512 chars in outbox", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    const longMsg = "x".repeat(1000)
    port.sendMessageBehavior = { kind: "reject_sync", code: "LONG", message: longMsg }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.errorMessage!.length).toBeLessThanOrEqual(512)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 13. Extended redaction – WebSocket URLs and absolute paths
// ════════════════════════════════════════════════════════════════════════

describe("extended redaction in Outbox", () => {
  test("ws:// and wss:// URLs are redacted in rejected outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "WS_ERR",
      message: "connect failed: wss://agent.internal.example.com/v2/stream?token=secret123 retry at ws://fallback:8080",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.errorCode).toBe("WS_ERR")
    expect(record!.errorMessage).toContain("[URL redacted]")
    expect(record!.errorMessage).not.toContain("wss://")
    expect(record!.errorMessage).not.toContain("ws://")
    expect(record!.errorMessage).not.toContain("agent.internal")
    expect(record!.errorMessage).not.toContain("secret123")
  })

  test("absolute Unix path is redacted in rejected outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "IO_ERR",
      message: "ENOENT: no such file or directory, open '/home/user/projects/app/config.yaml'",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.errorCode).toBe("IO_ERR")
    expect(record!.errorMessage).toContain("[path redacted]")
    expect(record!.errorMessage).not.toContain("/home/user/projects/app/config.yaml")
  })

  test("Windows drive path is redacted in rejected outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "IO_ERR",
      message: "cannot read file: D:\\Projects\\data\\output.json access denied",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.errorCode).toBe("IO_ERR")
    expect(record!.errorMessage).toContain("[path redacted]")
    expect(record!.errorMessage).not.toContain("D:\\")
    expect(record!.errorMessage).not.toContain("output.json")
  })

  test("UNC path is redacted in ambiguous outbox record", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_async",
      reason: "timeout",
      message: "share unavailable: \\\\fs01.internal\\shared\\assets timeout after 30s",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("ambiguous")
    expect(record!.errorMessage).toContain("[path redacted]")
    expect(record!.errorMessage).not.toContain("\\\\fs01")
    expect(record!.errorMessage).not.toContain("assets")
  })

  test("mixed URL, path, Bearer, and control chars are all redacted", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "MIXED",
      message:
        "fetch https://api.example.com/v1 failed\n\nat /home/runner/script.ts:42\nBearer abc123def456\nvia wss://gateway.example.com/ws\ncheck \\\\network\\share\\log.txt",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    expect(record!.errorCode).toBe("MIXED")
    const msg = record!.errorMessage!
    // All sensitive parts redacted
    expect(msg).toContain("[URL redacted]")
    expect(msg).toContain("[path redacted]")
    expect(msg).toContain("Bearer [token redacted]")
    expect(msg).not.toContain("abc123")
    expect(msg).not.toContain("https://")
    expect(msg).not.toContain("wss://")
    expect(msg).not.toContain("/home/runner")
    expect(msg).not.toContain("\\\\network")
    // Error code and disposition stable
    expect(msg).toContain("fetch")
    expect(msg).not.toContain("\n")
  })

  test("ordinary relative phrase remains readable", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "NORMAL",
      message: "module src/util/format.ts not found, import path './helpers' also failed, retry after 30s",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    expect(record!.state).toBe("rejected")
    const msg = record!.errorMessage!
    expect(msg).not.toContain("[path redacted]")
    expect(msg).not.toContain("[URL redacted]")
    expect(msg).toContain("src/util/format.ts")
    expect(msg).toContain("./helpers")
  })

  test("error message containing only a root file path /foo is not redacted as a path", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "MINOR",
      message: "config /etc OK but /var missing",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    const msg = record!.errorMessage!
    expect(msg).not.toContain("[path redacted]")
    expect(msg).toContain("/etc")
    expect(msg).toContain("/var")
  })

  test("idempotent: double application does not reveal partial tokens", async () => {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const port = new ControllableClarusPort()
    const rest = new DummyRest()
    const requestID = freshID("req")

    port.sendMessageBehavior = {
      kind: "reject_sync",
      code: "MULTI",
      message: "at /var/log/app/error.log Bearer xyz789 https://x.io/p ws://y.io/q",
    }

    await catchErr(
      ScopeContext.provide({
        scope,
        fn: async () => {
          await seedProject(scope)
          ClarusRuntime.configureRest(rest)
          await ClarusRuntime.attach(port)
          await port.connect()
          await ClarusRuntime.sendProjectMessage({
            requestID,
            agentId: AGENT_ID,
            projectId: PROJECT_ID,
            content: "test",
          })
        },
      }),
    )

    const record = await ClarusOutbox.get(requestID)
    expect(record).toBeDefined()
    const msg = record!.errorMessage!
    // Verify redactions are present
    expect(msg).toContain("[path redacted]")
    expect(msg).toContain("[URL redacted]")
    expect(msg).toContain("Bearer [token redacted]")
    // No partial reveals
    expect(msg).not.toContain("xyz789")
    expect(msg).not.toContain("/log/app")
    expect(msg).not.toContain("x.io")
    expect(msg).not.toContain("y.io")
  })
})
