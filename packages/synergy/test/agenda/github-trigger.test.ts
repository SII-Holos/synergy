import { afterEach, describe, expect, test } from "bun:test"
import { AgendaGithubTrigger } from "../../src/agenda/github-trigger"
import { AgendaTypes } from "../../src/agenda/types"

afterEach(() => {
  AgendaGithubTrigger.stop()
})

function makeItem(id: string, triggers: AgendaTypes.Trigger[]): AgendaTypes.Item {
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
        id: "scope-1",
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

function githubTrigger(overrides: Partial<AgendaTypes.Trigger & { type: "github" }> = {}): AgendaTypes.Trigger {
  return {
    type: "github",
    resource: "pr",
    repository: "owner/repo",
    interval: "30s",
    ...overrides,
  } as AgendaTypes.Trigger
}

// ---------------------------------------------------------------------------
// register / unregister / active
// ---------------------------------------------------------------------------

describe("register / unregister / active", () => {
  test("register with a github trigger shows one entry", () => {
    AgendaGithubTrigger.register("item-1", "scope-1", [githubTrigger()])
    expect(AgendaGithubTrigger.active()).toEqual({ items: 1, entries: 1 })
  })

  test("register with non-github triggers is ignored", () => {
    const triggers: AgendaTypes.Trigger[] = [
      { type: "cron", expr: "0 9 * * *" },
      { type: "every", interval: "30m" },
    ]
    AgendaGithubTrigger.register("item-2", "scope-1", triggers)
    expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
  })

  test("unregister removes entries and clears timers", () => {
    AgendaGithubTrigger.register("item-3", "scope-1", [githubTrigger()])
    expect(AgendaGithubTrigger.active()).toEqual({ items: 1, entries: 1 })
    AgendaGithubTrigger.unregister("item-3")
    expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
  })

  test("start registers active items and stop clears everything", () => {
    const item = makeItem("item-4", [githubTrigger()])
    AgendaGithubTrigger.start(async () => {}, [item])
    expect(AgendaGithubTrigger.active()).toEqual({ items: 1, entries: 1 })
    AgendaGithubTrigger.stop()
    expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
  })

  test("two triggers on one item create two entries", () => {
    AgendaGithubTrigger.register("item-5", "scope-1", [githubTrigger(), githubTrigger({ resource: "workflow" })])
    expect(AgendaGithubTrigger.active()).toEqual({ items: 1, entries: 2 })
  })
})

// ---------------------------------------------------------------------------
// schema / trigger type integration
// ---------------------------------------------------------------------------

describe("trigger schema integration", () => {
  test("github trigger parses and validates repository form", () => {
    const parsed = AgendaTypes.Trigger.safeParse(githubTrigger({ number: 42, states: ["merged"] }))
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.type).toBe("github")
    }
  })

  test("invalid repository form is rejected", () => {
    const parsed = AgendaTypes.Trigger.safeParse(githubTrigger({ repository: "not-a-repo-form" }))
    expect(parsed.success).toBe(false)
  })

  test("invalid interval format is rejected before persistence", () => {
    const parsed = AgendaTypes.Trigger.safeParse(githubTrigger({ interval: "five minutes" }))
    expect(parsed.success).toBe(false)
  })

  test("workflow and check triggers accept a ref", () => {
    const parsed = AgendaTypes.Trigger.safeParse(githubTrigger({ resource: "workflow", ref: "main" }))
    expect(parsed.success).toBe(true)
  })

  test("inferSessionMode treats github triggers as recurring", () => {
    expect(AgendaTypes.inferSessionMode([githubTrigger()])).toBe("persistent")
  })
})

// ---------------------------------------------------------------------------
// snapshot mapping / change collection
// ---------------------------------------------------------------------------

describe("snapshot mapping and change collection", () => {
  test("pr list snapshots detect merged via merged_at", () => {
    const merged = AgendaGithubTrigger.prSnapshot({ number: 1, state: "closed", merged_at: "2026-01-01T00:00:00Z" })
    expect(merged.state).toBe("merged")
    const open = AgendaGithubTrigger.prSnapshot({ number: 2, state: "open", draft: false, merged: false })
    expect(open.state).toBe("open")
  })

  test("workflow snapshot keeps status as state with conclusion separate and includes url", () => {
    const run = AgendaGithubTrigger.workflowSnapshot({
      id: 99,
      name: "CI",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/owner/repo/actions/runs/99",
    })
    expect(run.state).toBe("completed")
    expect(run.conclusion).toBe("success")
    expect(run.url).toBe("https://github.com/owner/repo/actions/runs/99")
  })

  test("collectChanges returns every transition in order and advances the baseline", () => {
    const lastStates = new Map<string, string>()
    const snapshots = [
      { resource: "pr" as const, number: 1, state: "open" },
      { resource: "pr" as const, number: 2, state: "closed" },
    ]
    // First poll primes the baseline without firing (no states filter).
    expect(
      AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: true, states: undefined }, snapshots),
    ).toEqual([])
    // Second poll observes both transitions.
    const changes = AgendaGithubTrigger.collectChanges(
      { lastStates, allowInitialMatch: true, states: undefined },
      snapshots.map((s) => ({ ...s, state: s.number === 1 ? "merged" : "closed" })),
    )
    expect(changes.map((c) => c.snapshot.number)).toEqual([1])
    expect(changes[0]?.previous).toBe("open")
    // Unchanged states do not fire again.
    expect(
      AgendaGithubTrigger.collectChanges(
        { lastStates, allowInitialMatch: true, states: undefined },
        snapshots.map((s) => ({ ...s, state: s.number === 1 ? "merged" : "closed" })),
      ),
    ).toEqual([])
  })

  test("first observation of an already-targeted state fires immediately", () => {
    // Watch created for an already-satisfied condition (or the state changed
    // between item creation and the first poll) must report, not stay silent.
    const lastStates = new Map<string, string>()
    const fired = AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: true, states: ["closed"] }, [
      { resource: "issue" as const, number: 1217, state: "closed" },
    ])
    expect(fired).toHaveLength(1)
    expect(fired[0]?.previous).toBeUndefined()
    expect(fired[0]?.snapshot.state).toBe("closed")
  })

  test("first observation without a states filter stays silent", () => {
    const lastStates = new Map<string, string>()
    expect(
      AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: true, states: undefined }, [
        { resource: "issue" as const, number: 1217, state: "closed" },
      ]),
    ).toEqual([])
  })

  test("restored items re-baseline silently instead of re-notifying", () => {
    // A restarted item (runCount > 0) must not re-fire for a state that was
    // already reported before the restart.
    const lastStates = new Map<string, string>()
    expect(
      AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["closed"] }, [
        { resource: "issue" as const, number: 1217, state: "closed" },
      ]),
    ).toEqual([])
  })

  test("states filter still advances the baseline for non-matching transitions", () => {
    const lastStates = new Map<string, string>()
    const snapshot = { resource: "pr" as const, number: 7, state: "open" }
    AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["merged"] }, [snapshot])
    const next = AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["merged"] }, [
      { ...snapshot, state: "draft" },
    ])
    expect(next).toEqual([])
    expect(lastStates.get("pr:7")).toBe("draft")
  })
})

// ---------------------------------------------------------------------------
// one-shot autoDone completion (review regression)
// ---------------------------------------------------------------------------

describe("autoDone completion", () => {
  test("updateRunState marks autoDone github items done after a successful fire", async () => {
    const { AgendaStore } = await import("../../src/agenda/store")
    const { tmpdir } = await import("../fixture/fixture")
    await using tmp = await tmpdir({ git: true })
    const { ScopeContext } = await import("../../src/scope/context")
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const item = await AgendaStore.create({
          title: "Watch PR merge",
          prompt: "check",
          triggers: [githubTrigger()],
          autoDone: true,
          createdBy: "agent",
        })
        const { item: updated } = await AgendaStore.updateRunState(
          item.origin.scope.id,
          item.id,
          { status: "ok", startTime: Date.now(), duration: 10, autoDone: true },
          item.triggers,
          "github",
        )
        expect(updated.status).toBe("done")
      },
    })
  })
})

test("workflow conclusion matches the states filter when a run completes", () => {
  const lastStates = new Map<string, string>()
  const run = { resource: "workflow" as const, number: 500, state: "completed", conclusion: "failure" }
  // Baseline: in-progress run without conclusion.
  AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["failure"] }, [
    { resource: "workflow" as const, number: 500, state: "in_progress" },
  ])
  // Run completes with failure — the conclusion matches the filter.
  const fired = AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["failure"] }, [run])
  expect(fired).toHaveLength(1)
  expect(fired[0]?.snapshot.conclusion).toBe("failure")
})

test("workflow conclusion filter does not fire for non-matching conclusions", () => {
  const lastStates = new Map<string, string>()
  AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["failure"] }, [
    { resource: "workflow" as const, number: 501, state: "in_progress" },
  ])
  const fired = AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["failure"] }, [
    { resource: "workflow" as const, number: 501, state: "completed", conclusion: "success" },
  ])
  expect(fired).toEqual([])
})

// ---------------------------------------------------------------------------
// watch disabled after creation (review round 3)
// ---------------------------------------------------------------------------

test("disabling github.watch pauses existing items instead of idling forever", async () => {
  const { AgendaStore } = await import("../../src/agenda/store")
  const { tmpdir } = await import("../fixture/fixture")
  const { ScopeContext } = await import("../../src/scope/context")
  await using tmp = await tmpdir({
    config: { github: { watch: { enabled: false } } },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const item = await AgendaStore.create({
        title: "Watch while disabled",
        prompt: "check",
        triggers: [githubTrigger()],
        createdBy: "agent",
      })
      expect(item.status).toBe("active")
      // Simulate the poll path taken when watchConfig reports disabled: the
      // entry unregisters and the item transitions to paused (releasing any
      // continuation holding it) rather than silently rescheduling forever.
      AgendaGithubTrigger.register(item.id, item.origin.scope.id, item.triggers)
      expect(AgendaGithubTrigger.active().items).toBe(1)
      const updated = await AgendaStore.update(item.origin.scope.id, item.id, { status: "paused" })
      expect(updated.status).toBe("paused")
      AgendaGithubTrigger.unregister(item.id)
      expect(AgendaGithubTrigger.active().items).toBe(0)
    },
  })
})

// ---------------------------------------------------------------------------
// teardown after completion (review round 3, blocking)
// ---------------------------------------------------------------------------

test("completed one-shot github watches stop polling — settleAfterFire drops the entry", async () => {
  const { AgendaStore } = await import("../../src/agenda/store")
  const { Agenda } = await import("../../src/agenda")
  const { tmpdir } = await import("../fixture/fixture")
  const { ScopeContext } = await import("../../src/scope/context")
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const item = await Agenda.create({
        title: "One-shot watch",
        prompt: "check",
        triggers: [githubTrigger()],
        autoDone: true,
        createdBy: "agent",
      })
      AgendaGithubTrigger.register(item.id, item.origin.scope.id, item.triggers)
      expect(AgendaGithubTrigger.active()).toEqual({ items: 1, entries: 1 })
      // The reactor marks the autoDone item done in updateRunState; the
      // handler's settleAfterFire must then drop the registration so the
      // poll loop stops rescheduling.
      await AgendaStore.updateRunState(
        item.origin.scope.id,
        item.id,
        { status: "ok", startTime: Date.now(), duration: 5, autoDone: true },
        item.triggers,
        "github",
      )
      await Agenda.settleAfterFire(
        { type: "github", source: item.id, payload: {}, timestamp: Date.now() },
        item.origin.scope.id,
      )
      expect((await AgendaStore.get(item.origin.scope.id, item.id)).status).toBe("done")
      expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
    },
  })
})

test("workflow conclusion null is normalized so baseline keys stay clean", () => {
  // GitHub returns conclusion: null for in-progress runs. If passed through,
  // the baseline key becomes "in_progress:null" and previousState leaks the
  // composite format to the agent on completion.
  const inProgress = AgendaGithubTrigger.workflowSnapshot({
    id: 600,
    name: "CI",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/owner/repo/actions/runs/600",
  })
  expect(inProgress.conclusion).toBeUndefined()

  const lastStates = new Map<string, string>()
  AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["failure"] }, [inProgress])
  expect(lastStates.get("workflow:600")).toBe("in_progress")

  const done = AgendaGithubTrigger.workflowSnapshot({
    id: 600,
    name: "CI",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/owner/repo/actions/runs/600",
  })
  const fired = AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: ["failure"] }, [
    done,
  ])
  expect(fired).toHaveLength(1)
  expect(fired[0]?.previous).toBe("in_progress")
})

test("closed draft PR reports closed (terminal state wins over draft)", () => {
  const snap = AgendaGithubTrigger.prSnapshot({
    number: 42,
    state: "closed",
    draft: true,
    merged: false,
  })
  expect(snap.state).toBe("closed")
  expect(snap.draft).toBe(true)
})

test("open draft PR reports draft", () => {
  const snap = AgendaGithubTrigger.prSnapshot({ number: 43, state: "open", draft: true, merged: false })
  expect(snap.state).toBe("draft")
})

test("baseline map is bounded to MAX_BASELINE_ENTRIES", () => {
  const lastStates = new Map<string, string>()
  // Push 300 distinct resource keys through collectChanges; the map must not
  // exceed the cap.
  for (let i = 0; i < 300; i++) {
    AgendaGithubTrigger.collectChanges({ lastStates, allowInitialMatch: false, states: undefined }, [
      { resource: "pr" as const, number: 1000 + i, state: "open" },
    ])
  }
  expect(lastStates.size).toBeLessThanOrEqual(256)
})

test("baseline eviction is LRU — actively observed resources are not evicted and re-fired", () => {
  const lastStates = new Map<string, string>()
  const states = ["closed"]
  const entry = () => ({ lastStates, allowInitialMatch: true, states })

  // PR 1 is observed closed from the start: first observation fires once.
  const initial = AgendaGithubTrigger.collectChanges(entry(), [{ resource: "pr" as const, number: 1, state: "closed" }])
  expect(initial).toHaveLength(1)

  // Fill the map to the cap with other PRs (open — filtered out, silent).
  for (let i = 2; i <= 256; i++) {
    AgendaGithubTrigger.collectChanges(entry(), [{ resource: "pr" as const, number: i, state: "open" }])
  }
  expect(lastStates.size).toBe(256)

  // Re-observe PR 1 (refreshes its LRU position; same state → no fire).
  expect(
    AgendaGithubTrigger.collectChanges(entry(), [{ resource: "pr" as const, number: 1, state: "closed" }]),
  ).toEqual([])

  // Overflow evicts the least recently observed (PR 2), not PR 1.
  AgendaGithubTrigger.collectChanges(entry(), [{ resource: "pr" as const, number: 257, state: "open" }])
  expect(lastStates.has("pr:1")).toBe(true)
  expect(lastStates.has("pr:2")).toBe(false)

  // PR 1 is still baselined: re-observing it must NOT fire as a duplicate
  // first observation.
  expect(
    AgendaGithubTrigger.collectChanges(entry(), [{ resource: "pr" as const, number: 1, state: "closed" }]),
  ).toEqual([])
})
