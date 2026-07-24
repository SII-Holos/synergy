import { describe, expect, test } from "bun:test"
import type {
  Event,
  EventReplayResult,
  EventStreamPayload,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  ScopeBootstrapResponse,
  Session,
  SessionInputResult,
  SessionMessagePage,
} from "@ericsanchezok/synergy-sdk/client"
import { createTuiController, type RuntimeAdapter } from "../src/controller"

function session(id: string, updated: number, title = id): Session {
  return {
    id,
    scope: { type: "project", id: "scope-1", directory: "/workspace" },
    title,
    version: "1",
    time: { created: updated, updated },
  }
}

function bootstrap(sessions = [session("s1", 1)]): ScopeBootstrapResponse {
  return {
    scopeID: "scope-1",
    provider: {
      all: [],
      connected: [],
      default: {},
      configProviders: [],
      catalogProviders: [],
      profiles: {},
      authHealth: {},
      runtimeAvailability: {},
      modelCatalog: {},
    },
    agent: [],
    config: {},
    command: [],
    sessions: { data: sessions, total: sessions.length, offset: 0, limit: 50 },
    cortex: [],
  }
}

function page(cursor: string | null = null): SessionMessagePage {
  return { items: [], referencedRoots: [], nextCursor: cursor, hasMore: cursor !== null, total: 0 }
}

function event<T extends Event["type"]>(
  type: T,
  properties: Extract<Event, { type: T }>["properties"],
  seq: number,
  epoch = "e1",
): Extract<Event, { type: T }> {
  return { type, properties, seq, epoch } as Extract<Event, { type: T }>
}

class EventQueue implements AsyncIterable<EventStreamPayload> {
  private values: EventStreamPayload[] = []
  private waiters: Array<(value: IteratorResult<EventStreamPayload>) => void> = []
  private ended = false

  push(value: EventStreamPayload) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close() {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<EventStreamPayload> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

class FakeAdapter implements RuntimeAdapter {
  readonly events = new EventQueue()
  readonly calls: string[] = []
  eventStreams = [this.events]
  bootstrapSnapshots = [{ data: bootstrap(), epoch: "e1", seq: 1 }]
  replayResult: EventReplayResult = { status: "ok", epoch: "e1", seq: 1, events: [] }
  replayFailures = 0
  interactions = { permissions: [] as PermissionRequest[], questions: [] as QuestionRequest[] }
  pages = [page()]
  listedSessions = [session("s1", 1)]
  async health() {
    this.calls.push("health")
    return { healthy: true as const, version: "1", modelReady: true }
  }
  async bootstrap() {
    this.calls.push("bootstrap")
    return this.bootstrapSnapshots.shift() ?? { data: bootstrap(), epoch: "e1", seq: 1 }
  }
  async listInteractions() {
    this.calls.push("interactions")
    return this.interactions
  }
  async listSessions() {
    this.calls.push("sessions")
    return this.listedSessions
  }
  async subscribe(_signal: AbortSignal) {
    this.calls.push("subscribe")
    return this.eventStreams.shift() ?? new EventQueue()
  }
  async replay(since: number, epoch?: string) {
    this.calls.push(`replay:${since}:${epoch ?? ""}`)
    if (this.replayFailures > 0) {
      this.replayFailures--
      throw new Error("temporary replay failure")
    }
    return this.replayResult
  }
  async messagePage(sessionID: string, cursor?: string) {
    this.calls.push(`messages:${sessionID}:${cursor ?? ""}`)
    return this.pages.shift() ?? page()
  }
  async sessionResources(sessionID: string) {
    this.calls.push(`resources:${sessionID}`)
    return { todos: [], dag: [] }
  }
  async getSession(sessionID: string) {
    this.calls.push(`get:${sessionID}`)
    return session(sessionID, 1)
  }
  async createSession(title?: string) {
    this.calls.push(`create:${title ?? ""}`)
    return session("created", 3, title ?? "created")
  }
  async updateSession(sessionID: string, patch: { title?: string; pinned?: number; archived?: number }) {
    this.calls.push(`update:${sessionID}`)
    return session(sessionID, 4, patch.title ?? sessionID)
  }
  async deleteSession(sessionID: string) {
    this.calls.push(`delete:${sessionID}`)
  }
  async sendInput(sessionID: string, text: string): Promise<SessionInputResult> {
    this.calls.push(`input:${sessionID}:${text}`)
    return { status: "started", messageID: "m1" }
  }
  async sendCommand(sessionID: string, command: string, args?: string) {
    this.calls.push(`command:${sessionID}:${command}:${args ?? ""}`)
  }
  async abortSession(sessionID: string) {
    this.calls.push(`abort:${sessionID}`)
  }
  async replyPermission(requestID: string, reply: "once" | "session" | "always" | "reject", message?: string) {
    this.calls.push(`permission:${requestID}:${reply}:${message ?? ""}`)
  }
  async replyQuestion(requestID: string, answers: QuestionAnswer[]) {
    this.calls.push(`question:${requestID}:${answers.flat().join(",")}`)
  }
  async rejectQuestion(requestID: string) {
    this.calls.push(`reject-question:${requestID}`)
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Bun.sleep(0)
}

describe("TUI controller", () => {
  test("subscribes before bootstrap and applies buffered events after the snapshot watermark", async () => {
    const adapter = new FakeAdapter()
    const controller = createTuiController(adapter)
    const starting = controller.start()
    await settle()
    adapter.events.push(event("session.updated", { info: session("s2", 2) }, 2))
    await starting

    expect(adapter.calls.indexOf("subscribe")).toBeLessThan(adapter.calls.indexOf("bootstrap"))
    expect(controller.getState().sessions.map((item) => item.id)).toEqual(["s2", "s1"])
    expect(controller.getState().connection).toBe("live")
    expect(adapter.calls).toContain("messages:s1:")
    controller.stop()
  })

  test("loads older pages with the current cursor", async () => {
    const adapter = new FakeAdapter()
    adapter.pages = [page("older"), page(null)]
    const controller = createTuiController(adapter)
    await controller.start()
    await controller.loadOlder()
    expect(adapter.calls).toContain("messages:s1:older")
    controller.stop()
  })

  test("replays a sequence gap and applies the complete replay result", async () => {
    const adapter = new FakeAdapter()
    adapter.replayResult = {
      status: "ok",
      epoch: "e1",
      seq: 3,
      events: [
        event("session.updated", { info: session("s2", 2) }, 2),
        event("session.updated", { info: session("s3", 3) }, 3),
      ],
    }
    const controller = createTuiController(adapter)
    await controller.start()
    adapter.events.push(event("session.updated", { info: session("s3", 3) }, 3))
    await settle()

    expect(adapter.calls).toContain("replay:1:e1")
    expect(controller.getState().sessions.map((item) => item.id)).toEqual(["s3", "s2", "s1"])
    expect(controller.getState().sync.seq).toBe(3)
    controller.stop()
  })

  test("rebootstraps and reloads the active conversation after replay reset", async () => {
    const adapter = new FakeAdapter()
    adapter.bootstrapSnapshots.push({ data: bootstrap([session("s2", 2)]), epoch: "e2", seq: 1 })
    adapter.replayResult = { status: "reset", epoch: "e2", seq: 1 }
    const controller = createTuiController(adapter)
    await controller.start()
    adapter.events.push(event("session.updated", { info: session("s2", 2) }, 3))
    await settle()

    expect(adapter.calls.filter((call) => call === "bootstrap")).toHaveLength(2)
    expect(controller.getState().sessions.map((item) => item.id)).toEqual(["s2"])
    expect(controller.getState().sync).toEqual({ epoch: "e2", seq: 1, needsBootstrap: false })
    controller.stop()
  })

  test("applies the initial session only once across recovery bootstraps", async () => {
    const adapter = new FakeAdapter()
    const sessions = [session("s2", 2), session("s1", 1)]
    adapter.bootstrapSnapshots = [
      { data: bootstrap(sessions), epoch: "e1", seq: 1 },
      { data: bootstrap(sessions), epoch: "e2", seq: 1 },
    ]
    adapter.replayResult = { status: "reset", epoch: "e2", seq: 1 }
    const controller = createTuiController(adapter, { sessionID: "s1" })
    await controller.start()
    await controller.selectSession("s2")

    adapter.events.push(event("session.updated", { info: session("s2", 3) }, 3))
    await settle()

    expect(adapter.calls.filter((call) => call === "bootstrap")).toHaveLength(2)
    expect(controller.getState().activeSessionID).toBe("s2")
    controller.stop()
  })

  test("retries a failed recovery after the event stream disconnects", async () => {
    const adapter = new FakeAdapter()
    adapter.eventStreams.push(new EventQueue(), new EventQueue())
    adapter.replayFailures = 1
    const delays: number[] = []
    const controller = createTuiController(adapter, {
      reconnectBackoff: { initialMs: 10, maxMs: 20, jitter: 0 },
      sleep: async (delay) => {
        delays.push(delay)
      },
    })
    await controller.start()

    adapter.events.close()
    for (let attempt = 0; attempt < 20 && adapter.calls.filter((call) => call === "subscribe").length < 3; attempt++)
      await settle()

    expect(adapter.calls.filter((call) => call === "subscribe")).toHaveLength(3)
    expect(adapter.calls.filter((call) => call === "replay:1:e1")).toHaveLength(2)
    expect(delays).toEqual([10, 20])
    expect(controller.getState().connection).toBe("live")
    controller.stop()
  })

  test("loads the fallback conversation when the active session is deleted remotely", async () => {
    const adapter = new FakeAdapter()
    adapter.bootstrapSnapshots = [{ data: bootstrap([session("s2", 2), session("s1", 1)]), epoch: "e1", seq: 1 }]
    const controller = createTuiController(adapter, { sessionID: "s1" })
    await controller.start()

    adapter.events.push(event("session.deleted", { info: session("s1", 1) }, 2))
    await settle()

    expect(controller.getState().activeSessionID).toBe("s2")
    expect(adapter.calls.filter((call) => call === "messages:s2:")).toHaveLength(1)
    expect(adapter.calls.filter((call) => call === "resources:s2")).toHaveLength(1)
    controller.stop()
  })

  test("replaces a partial bootstrap session page with the complete session list", async () => {
    const adapter = new FakeAdapter()
    const first = session("s1", 1)
    const second = session("s2", 2)
    adapter.bootstrapSnapshots = [
      {
        data: { ...bootstrap([first]), sessions: { data: [first], total: 2, offset: 0, limit: 1 } },
        epoch: "e1",
        seq: 1,
      },
    ]
    adapter.listedSessions = [second, first]
    const controller = createTuiController(adapter)

    await controller.start()

    expect(adapter.calls).toContain("sessions")
    expect(controller.getState().sessions.map((item) => item.id)).toEqual(["s2", "s1"])
    controller.stop()
  })

  test("exposes session and interaction operations through the adapter", async () => {
    const adapter = new FakeAdapter()
    const controller = createTuiController(adapter)
    await controller.start()

    await controller.createSession("New")
    await controller.renameSession("created", "Renamed")
    await controller.sendInput("hello")
    await controller.sendCommand("review", "--all")
    await controller.abort()
    await controller.replyPermission("perm-1", "once", "ok")
    await controller.replyQuestion("q-1", [["Safe"]])
    await controller.rejectQuestion("q-2")
    await controller.deleteSession("created")

    expect(adapter.calls).toEqual(
      expect.arrayContaining([
        "create:New",
        "update:created",
        "input:created:hello",
        "command:created:review:--all",
        "abort:created",
        "permission:perm-1:once:ok",
        "question:q-1:Safe",
        "reject-question:q-2",
        "delete:created",
      ]),
    )
    expect(controller.getState().sessions.some((item) => item.id === "created")).toBe(false)
    controller.stop()
  })
})
