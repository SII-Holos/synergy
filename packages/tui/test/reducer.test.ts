import { describe, expect, test } from "bun:test"
import type {
  DagNode,
  Event,
  EventMessagePartDelta,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionMessagePage,
  Todo,
} from "@ericsanchezok/synergy-sdk/client"
import { createTuiState, reduceTuiState } from "../src/reducer"

function session(id: string, updated: number, title = id): Session {
  return {
    id,
    scope: { type: "project", id: "scope-1", directory: "/workspace" },
    title,
    version: "1",
    time: { created: updated, updated },
  }
}

function message(id: string, sessionID = "s1", created = 1): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  }
}

function textPart(id: string, messageID = "m1", text = "hello"): Part {
  return { id, sessionID: "s1", messageID, type: "text", text }
}

function page(items: Array<{ info: Message; parts: Part[] }>, nextCursor: string | null = null): SessionMessagePage {
  return { items, referencedRoots: [], nextCursor, hasMore: nextCursor !== null, total: items.length }
}

function event<T extends Event["type"]>(
  type: T,
  properties: Extract<Event, { type: T }>["properties"],
  seq?: number,
  epoch = "e1",
): Extract<Event, { type: T }> {
  return { type, properties, ...(seq === undefined ? {} : { seq, epoch }) } as Extract<Event, { type: T }>
}

describe("TUI state reducer", () => {
  test("bootstraps sessions, metadata, and an explicit sync watermark", () => {
    const state = reduceTuiState(createTuiState(), {
      type: "bootstrap",
      payload: {
        scopeID: "scope-1",
        sessions: [session("old", 1), session("new", 2)],
        sessionStatus: { new: { type: "busy" } },
        command: [],
        agent: [],
        cortex: [],
        epoch: "e1",
        seq: 5,
      },
    })
    expect(state.sessions.map((item) => item.id)).toEqual(["new", "old"])
    expect(state.activeSessionID).toBe("new")
    expect(state.sessionStatus.new).toEqual({ type: "busy" })
    expect(state.sync).toEqual({ epoch: "e1", seq: 5, needsBootstrap: false })
  })

  test("loads and prepends message pages without duplicates", () => {
    let state = reduceTuiState(createTuiState(), { type: "select-session", sessionID: "s1" })
    state = reduceTuiState(state, {
      type: "message-page",
      sessionID: "s1",
      page: page([{ info: message("m2", "s1", 2), parts: [textPart("p2", "m2", "two")] }], "older"),
      mode: "replace",
    })
    state = reduceTuiState(state, {
      type: "message-page",
      sessionID: "s1",
      page: page([
        { info: message("m1", "s1", 1), parts: [textPart("p1", "m1", "one")] },
        { info: message("m2", "s1", 2), parts: [textPart("p2", "m2", "two")] },
      ]),
      mode: "prepend",
    })
    const conversation = state.conversations.s1!
    expect(conversation.messageOrder).toEqual(["m1", "m2"])
    expect(conversation.partsByMessage.m1).toEqual(["p1"])
    expect(conversation.hasMore).toBe(false)
  })

  test("appends streaming deltas and converges on checkpoints", () => {
    let state = reduceTuiState(createTuiState(), {
      type: "message-page",
      sessionID: "s1",
      page: page([{ info: message("m1"), parts: [textPart("p1", "m1", "hel")] }]),
      mode: "replace",
    })
    const delta: EventMessagePartDelta = {
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", partID: "p1", kind: "text", delta: "lo" },
    }
    state = reduceTuiState(state, { type: "event", event: delta })
    expect(state.conversations.s1!.parts.p1).toMatchObject({ text: "hello" })

    state = reduceTuiState(state, {
      type: "event",
      event: event("message.part.updated", { part: textPart("p1", "m1", "hello!") }, 1),
    })
    expect(state.conversations.s1!.parts.p1).toMatchObject({ text: "hello!" })
  })

  test("advances only the changed message revision during streaming", () => {
    let state = reduceTuiState(createTuiState(), {
      type: "message-page",
      sessionID: "s1",
      page: page([
        { info: message("m1", "s1", 1), parts: [textPart("p1", "m1", "history")] },
        { info: message("m2", "s1", 2), parts: [textPart("p2", "m2", "stream")] },
      ]),
      mode: "replace",
    })
    const before = state.conversations.s1!.messageRevisions

    state = reduceTuiState(state, {
      type: "event",
      event: {
        type: "message.part.delta",
        properties: { sessionID: "s1", messageID: "m2", partID: "p2", kind: "text", delta: "ing" },
      },
    })

    expect(state.conversations.s1!.messageRevisions.m1).toBe(before.m1)
    expect(state.conversations.s1!.messageRevisions.m2).toBeGreaterThan(before.m2 ?? 0)
  })

  test("blocks a gap for replay and an epoch change for bootstrap", () => {
    const base = reduceTuiState(createTuiState(), {
      type: "bootstrap",
      payload: { scopeID: "scope-1", sessions: [], command: [], agent: [], cortex: [], epoch: "e1", seq: 4 },
    })
    const gap = reduceTuiState(base, {
      type: "event",
      event: event("session.updated", { info: session("s1", 1) }, 6),
    })
    expect(gap.sessions).toHaveLength(0)
    expect(gap.sync).toMatchObject({ needsReplay: true, replayFrom: 4, seq: 4 })

    const restarted = reduceTuiState(base, {
      type: "event",
      event: event("session.updated", { info: session("s1", 1) }, 1, "e2"),
    })
    expect(restarted.sessions).toHaveLength(0)
    expect(restarted.sync.needsBootstrap).toBe(true)
  })

  test("applies ordered replay and advances the authoritative watermark", () => {
    let state = reduceTuiState(createTuiState(), {
      type: "bootstrap",
      payload: { scopeID: "scope-1", sessions: [], command: [], agent: [], cortex: [], epoch: "e1", seq: 4 },
    })
    state = reduceTuiState(state, {
      type: "replay",
      result: {
        status: "ok",
        epoch: "e1",
        seq: 6,
        events: [
          event("session.updated", { info: session("s1", 1) }, 5),
          event("session.updated", { info: session("s2", 2) }, 6),
        ],
      },
    })
    expect(state.sessions.map((item) => item.id)).toEqual(["s2", "s1"])
    expect(state.sync).toEqual({ epoch: "e1", seq: 6, needsBootstrap: false })
  })

  test("reconciles sessions, status, todos, DAG, permissions, and questions", () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "s1",
      permission: "shell",
      patterns: ["git status"],
      metadata: {},
    }
    const question: QuestionRequest = {
      id: "q-1",
      sessionID: "s1",
      questions: [{ header: "Mode", question: "Choose", options: [{ label: "Safe", description: "safe" }] }],
    }
    const todos: Todo[] = [{ id: "t1", content: "Ship", status: "pending", priority: "high" }]
    const nodes: DagNode[] = [{ id: "n1", content: "Build", status: "running", deps: [] }]

    let state = createTuiState()
    const events: Event[] = [
      event("session.updated", { info: session("s1", 1) }),
      event("session.status", { sessionID: "s1", status: { type: "busy" } }),
      event("todo.updated", { sessionID: "s1", todos }),
      event("dag.updated", { sessionID: "s1", nodes, ready: [] }),
      event("permission.asked", permission),
      event("question.asked", question),
    ]
    for (const item of events) state = reduceTuiState(state, { type: "event", event: item })

    expect(state.sessionStatus.s1).toEqual({ type: "busy" })
    expect(state.todos.s1).toEqual(todos)
    expect(state.dag.s1).toEqual(nodes)
    expect(state.permissions.s1?.[0]?.id).toBe("perm-1")
    expect(state.questions.s1?.[0]?.id).toBe("q-1")

    state = reduceTuiState(state, {
      type: "event",
      event: event("permission.replied", { sessionID: "s1", requestID: "perm-1", reply: "once" }),
    })
    state = reduceTuiState(state, {
      type: "event",
      event: event("question.rejected", { sessionID: "s1", requestID: "q-1" }),
    })
    expect(state.permissions.s1).toEqual([])
    expect(state.questions.s1).toEqual([])
  })

  test("removes a deleted active session and chooses a stable fallback", () => {
    let state = reduceTuiState(createTuiState(), {
      type: "bootstrap",
      payload: {
        scopeID: "scope-1",
        sessions: [session("s2", 2), session("s1", 1)],
        command: [],
        agent: [],
        cortex: [],
      },
    })
    state = reduceTuiState(state, { type: "select-session", sessionID: "s1" })
    state = reduceTuiState(state, {
      type: "event",
      event: event("session.deleted", { info: session("s1", 1) }),
    })
    expect(state.sessions.map((item) => item.id)).toEqual(["s2"])
    expect(state.activeSessionID).toBe("s2")
    expect(state.conversations.s1).toBeUndefined()
  })
})
