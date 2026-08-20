import { afterEach, describe, expect, mock, test } from "bun:test"
import { AgendaSessionTrigger } from "../../src/agenda/session-trigger"
import { AgendaStore } from "../../src/agenda/store"
import { AgendaReactor } from "../../src/agenda/reactor"
import { AgendaTypes } from "../../src/agenda/types"
import { SessionEvent } from "../../src/session/event"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionDrive } from "../../src/session/drive"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
const originalInvoke = SessionInvoke.invoke
const originalDriveRequest = SessionDrive.request

afterEach(() => {
  AgendaSessionTrigger.stop()
  ;(SessionInvoke.invoke as typeof SessionInvoke.invoke) = originalInvoke
  ;(SessionDrive.request as typeof SessionDrive.request) = originalDriveRequest
})

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
}

function makeItem(id: string, triggers: AgendaTypes.Trigger[], scopeID = "scope-1"): AgendaTypes.Item {
  const now = Date.now()
  return {
    id,
    status: "active",
    title: `Test item ${id}`,
    global: false,
    triggers,
    prompt: "test",
    wake: true,
    silent: false,
    autoDone: false,
    origin: {
      scope: {
        type: "project",
        id: scopeID,
        directory: "/tmp",
        worktree: "/tmp",
        sandboxes: [],
        time: { created: now, updated: now },
      },
    },
    createdBy: "user",
    state: { consecutiveErrors: 0, runCount: 0 },
    time: { created: now, updated: now },
  }
}

function noop() {
  return Promise.resolve()
}

async function publishTurnEnd(props: {
  sessionID: string
  messageID: string
  finish?: string
  agent?: string
}): Promise<void> {
  await ScopeContext.provide({
    scope: await (await tmpdir()).scope(),
    fn: () => Bus.publish(SessionEvent.TurnEnd, props),
  })
}

async function publishTurnStart(props: { sessionID: string; messageID: string; agent?: string }): Promise<void> {
  await ScopeContext.provide({
    scope: await (await tmpdir()).scope(),
    fn: () => Bus.publish(SessionEvent.TurnStart, props),
  })
}

function sessionTrigger(overrides: Partial<AgendaTypes.Trigger & { type: "session" }> = {}): AgendaTypes.Trigger {
  return {
    type: "session",
    sessionID: "ses_research",
    event: "turn.end",
    once: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// register / unregister / active
// ---------------------------------------------------------------------------

describe("register / unregister / active", () => {
  test("register with a session trigger shows one entry", () => {
    AgendaSessionTrigger.register("item-1", "scope-1", [sessionTrigger()])
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 1, entries: 1 })
  })

  test("register with non-session triggers is ignored", () => {
    const triggers: AgendaTypes.Trigger[] = [
      { type: "cron", expr: "0 9 * * *" },
      { type: "every", interval: "30m" },
    ]
    AgendaSessionTrigger.register("item-2", "scope-1", triggers)
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 0, entries: 0 })
  })

  test("unregister removes all entries for an item", () => {
    AgendaSessionTrigger.register("item-3", "scope-1", [sessionTrigger()])
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 1, entries: 1 })
    AgendaSessionTrigger.unregister("item-3")
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 0, entries: 0 })
  })

  test("two items watching the same session share one session key", () => {
    AgendaSessionTrigger.register("item-a", "scope-1", [sessionTrigger()])
    AgendaSessionTrigger.register("item-b", "scope-2", [sessionTrigger()])
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 1, entries: 2 })
  })
})

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

describe("start / stop lifecycle", () => {
  test("start registers items with session triggers", () => {
    const items = [makeItem("item-b", [sessionTrigger()])]
    AgendaSessionTrigger.start(noop, items)
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 1, entries: 1 })
  })

  test("start with items that have no session triggers gives zero entries", () => {
    const items = [makeItem("item-c", [{ type: "cron", expr: "0 9 * * *" }])]
    AgendaSessionTrigger.start(noop, items)
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 0, entries: 0 })
  })

  test("stop clears everything", () => {
    AgendaSessionTrigger.start(noop, [makeItem("item-d", [sessionTrigger()])])
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 1, entries: 1 })
    AgendaSessionTrigger.stop()
    expect(AgendaSessionTrigger.active()).toEqual({ sessions: 0, entries: 0 })
  })
})

// ---------------------------------------------------------------------------
// event matching
// ---------------------------------------------------------------------------

describe("event matching", () => {
  test("matching sessionID and event fires handler with session signal", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaSessionTrigger.start(handler, [])
    AgendaSessionTrigger.register("item-1", "scope-1", [sessionTrigger()])

    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1", finish: "stop", agent: "research" })

    await waitUntil(() => calls.length === 1)
    expect(calls[0]!.signal.type).toBe("session")
    expect(calls[0]!.signal.source).toBe("item-1")
    expect(calls[0]!.signal.payload).toEqual({
      sessionID: "ses_research",
      messageID: "msg_1",
      finish: "stop",
      agent: "research",
    })
    expect(calls[0]!.scopeID).toBe("scope-1")
  })

  test("turn.end trigger does not fire on turn.start events", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-2", "scope-1", [sessionTrigger()])

    await publishTurnStart({ sessionID: "ses_research", messageID: "msg_1" })
    await Bun.sleep(50)
    expect(calls).toHaveLength(0)
  })

  test("turn.start trigger fires on turn.start events", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-3", "scope-1", [sessionTrigger({ event: "turn.start" })])

    await publishTurnStart({ sessionID: "ses_research", messageID: "msg_1", agent: "research" })

    await waitUntil(() => calls.length === 1)
    expect(calls[0]!.signal.payload).toMatchObject({ sessionID: "ses_research", messageID: "msg_1" })
  })

  test("non-matching sessionID does NOT fire", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-4", "scope-1", [sessionTrigger()])

    await publishTurnEnd({ sessionID: "ses_other", messageID: "msg_1" })
    await Bun.sleep(50)
    expect(calls).toHaveLength(0)
  })

  test("agent filter rejects non-matching agent", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-5", "scope-1", [sessionTrigger({ agent: "research" })])

    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1", agent: "boss" })
    await Bun.sleep(50)
    expect(calls).toHaveLength(0)
  })

  test("finish filter rejects non-matching finish", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-6", "scope-1", [sessionTrigger({ finish: "stop" })])

    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1", finish: "error" })
    await Bun.sleep(50)
    expect(calls).toHaveLength(0)
  })

  test("messageID dedup — duplicate TurnEnd for the same turn fires once", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-7", "scope-1", [sessionTrigger()])

    // processor and invoke both publish TurnEnd for the same assistant message
    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1" })
    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1" })

    await waitUntil(() => calls.length === 1)
    expect(calls[0]!.signal.payload).toMatchObject({ messageID: "msg_1" })
  })

  test("a later turn with a new messageID fires again", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-8", "scope-1", [sessionTrigger({ once: false })])

    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1" })
    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_2" })

    await waitUntil(() => calls.length === 2)
  })

  test("same item with turn.start + turn.end both fire for the same turn", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    AgendaSessionTrigger.start(async (signal, scopeID) => {
      calls.push({ signal, scopeID })
    }, [])
    AgendaSessionTrigger.register("item-dual", "scope-1", [
      sessionTrigger({ event: "turn.start" }),
      sessionTrigger({ event: "turn.end" }),
    ])

    await publishTurnStart({ sessionID: "ses_research", messageID: "msg_1" })
    await publishTurnEnd({ sessionID: "ses_research", messageID: "msg_1" })

    await waitUntil(() => calls.length === 2)
    const events = calls.map((c) => c.signal.payload).map((p) => (p as { messageID: string }).messageID)
    expect(events).toEqual(["msg_1", "msg_1"])
  })
})

// ---------------------------------------------------------------------------
// session mode inference
// ---------------------------------------------------------------------------

describe("session mode inference", () => {
  test("once:true session trigger defaults to ephemeral", () => {
    expect(AgendaTypes.inferSessionMode([sessionTrigger({ once: true })])).toBe("ephemeral")
  })

  test("once:false session trigger defaults to persistent", () => {
    expect(AgendaTypes.inferSessionMode([sessionTrigger({ once: false })])).toBe("persistent")
  })

  test("mixed session + cron defaults to persistent", () => {
    expect(AgendaTypes.inferSessionMode([sessionTrigger({ once: true }), { type: "cron", expr: "0 9 * * *" }])).toBe(
      "persistent",
    )
  })
})

// ---------------------------------------------------------------------------
// end-to-end: turn.end → agenda item executes
// ---------------------------------------------------------------------------

describe("end-to-end", () => {
  test("publishing TurnEnd for the watched session runs the agenda item", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const origin = await Session.create({ title: "boss" })
        let invokeCalls = 0
        ;(SessionInvoke.invoke as unknown as (...args: unknown[]) => unknown) = mock(async () => {
          invokeCalls++
          return { info: { id: "exec-msg" }, parts: [] }
        })
        // Delivery calls SessionDrive.request with waitForProcessing on the origin
        // session, which has no running loop in this test — mock it to resolve.
        ;(SessionDrive.request as unknown as (...args: unknown[]) => unknown) = mock(async () => true)

        const item = await AgendaStore.create({
          title: "report research",
          prompt: "Summarize the research session's turn.",
          triggers: [{ type: "session", sessionID: "ses_research", event: "turn.end", once: true }],
          createdBy: "agent",
          sessionID: origin.id,
        })

        const fired: AgendaTypes.FiredSignal[] = []
        let reactorDone = false
        AgendaSessionTrigger.start(
          async (signal, scopeID) => {
            fired.push(signal)
            await AgendaReactor.execute(signal, scopeID)
            reactorDone = true
          },
          [item],
        )

        await Bus.publish(SessionEvent.TurnEnd, {
          sessionID: "ses_research",
          messageID: "msg_1",
          finish: "stop",
          agent: "research",
        })

        // Wait for the full reactor run (session creation + invoke + run-state update)
        await waitUntil(() => reactorDone)

        expect(invokeCalls).toBe(1)
        expect(fired).toHaveLength(1)
        expect(fired[0]!.type).toBe("session")
        expect(fired[0]!.payload).toMatchObject({ sessionID: "ses_research", messageID: "msg_1", finish: "stop" })

        const stored = await AgendaStore.get(ScopeContext.current.scope.id, item.id)
        expect(stored.state.runCount).toBe(1)
        expect(stored.state.lastRunStatus).toBe("ok")
        // once:true + no time triggers → auto-done after the first fire
        expect(stored.status).toBe("done")
      },
    })
  })
})
