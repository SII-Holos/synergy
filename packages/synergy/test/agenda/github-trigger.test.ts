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

  test("inferSessionMode treats github triggers as recurring", () => {
    expect(AgendaTypes.inferSessionMode([githubTrigger()])).toBe("persistent")
  })
})
