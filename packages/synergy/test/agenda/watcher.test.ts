import { afterEach, describe, expect, test } from "bun:test"
import { AgendaWatcher } from "../../src/agenda/watcher"
import { AgendaTypes } from "../../src/agenda/types"
import { GlobalBus } from "../../src/bus/global"
import path from "path"
import fs from "fs"
import os from "os"

afterEach(() => {
  AgendaWatcher.stop()
})

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
}

async function ensureNoCallDuring<T>(calls: T[], action: () => Promise<void> | void, timeoutMs = 100): Promise<void> {
  const initialCount = calls.length
  await action()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (calls.length > initialCount) {
      throw new Error(`Unexpected call occurred during ${timeoutMs}ms wait`)
    }
    await Bun.sleep(5)
  }
  expect(calls.length).toBe(initialCount)
}

function makePollTrigger(opts: {
  command: string
  interval?: string
  trigger?: "change" | "match"
  match?: string
}): AgendaTypes.Trigger {
  return {
    type: "watch",
    watch: {
      kind: "poll",
      command: opts.command,
      interval: opts.interval ?? "10ms",
      trigger: opts.trigger ?? "change",
      match: opts.match,
    },
  }
}

function makeFileTrigger(opts: {
  glob: string
  event?: "add" | "change" | "unlink"
  debounce?: string
}): AgendaTypes.Trigger {
  return {
    type: "watch",
    watch: {
      kind: "file",
      glob: opts.glob,
      event: opts.event,
      debounce: opts.debounce ?? "10ms",
    },
  }
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

// ---------------------------------------------------------------------------
// register / unregister / active
// ---------------------------------------------------------------------------

describe("register / unregister / active", () => {
  test("register with a poll trigger shows polls: 1, files: 0", () => {
    AgendaWatcher.register("item-1", "scope-1", [makePollTrigger({ command: "echo hi" })])
    expect(AgendaWatcher.active()).toEqual({ polls: 1, files: 0, tools: 0 })
  })

  test("register with a file trigger shows polls: 0, files: 1", () => {
    AgendaWatcher.register("item-2", "scope-1", [makeFileTrigger({ glob: "src/**/*.ts" })])
    expect(AgendaWatcher.active()).toEqual({ polls: 0, files: 1, tools: 0 })
  })

  test("register with mixed triggers shows polls: 1, files: 1", () => {
    AgendaWatcher.register("item-3", "scope-1", [
      makePollTrigger({ command: "echo hi" }),
      makeFileTrigger({ glob: "*.ts" }),
    ])
    expect(AgendaWatcher.active()).toEqual({ polls: 1, files: 1, tools: 0 })
  })

  test("register with non-watch triggers is ignored", () => {
    const triggers: AgendaTypes.Trigger[] = [
      { type: "cron", expr: "0 9 * * *" },
      { type: "every", interval: "30m" },
    ]
    AgendaWatcher.register("item-4", "scope-1", triggers)
    expect(AgendaWatcher.active()).toEqual({ polls: 0, files: 0, tools: 0 })
  })

  test("unregister removes all watches for an item", () => {
    AgendaWatcher.register("item-5", "scope-1", [
      makePollTrigger({ command: "echo hi" }),
      makeFileTrigger({ glob: "*.ts" }),
    ])
    expect(AgendaWatcher.active()).toEqual({ polls: 1, files: 1, tools: 0 })

    AgendaWatcher.unregister("item-5")
    expect(AgendaWatcher.active()).toEqual({ polls: 0, files: 0, tools: 0 })
  })
})

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

describe("start / stop lifecycle", () => {
  test("start with items containing watch triggers registers them", () => {
    const items = [
      makeItem("item-a", [makePollTrigger({ command: "echo a" })]),
      makeItem("item-b", [makeFileTrigger({ glob: "**/*.json" })]),
    ]
    AgendaWatcher.start(noop, items)
    expect(AgendaWatcher.active()).toEqual({ polls: 1, files: 1, tools: 0 })
  })

  test("start with items that have no watch triggers gives 0, 0", () => {
    const items = [makeItem("item-c", [{ type: "cron", expr: "0 9 * * *" }])]
    AgendaWatcher.start(noop, items)
    expect(AgendaWatcher.active()).toEqual({ polls: 0, files: 0, tools: 0 })
  })

  test("stop clears everything", () => {
    AgendaWatcher.start(noop, [makeItem("item-d", [makePollTrigger({ command: "echo d" })])])
    expect(AgendaWatcher.active()).toEqual({ polls: 1, files: 0, tools: 0 })

    AgendaWatcher.stop()
    expect(AgendaWatcher.active()).toEqual({ polls: 0, files: 0, tools: 0 })
  })

  test("stop after start + manual registers clears all", () => {
    AgendaWatcher.start(noop, [])
    AgendaWatcher.register("item-e", "scope-1", [makePollTrigger({ command: "echo e" })])
    AgendaWatcher.register("item-f", "scope-1", [makeFileTrigger({ glob: "*.md" })])
    expect(AgendaWatcher.active()).toEqual({ polls: 1, files: 1, tools: 0 })

    AgendaWatcher.stop()
    expect(AgendaWatcher.active()).toEqual({ polls: 0, files: 0, tools: 0 })
  })
})

// ---------------------------------------------------------------------------
// poll — change detection
// ---------------------------------------------------------------------------

describe("poll — change detection", () => {
  test("first poll does NOT fire handler (baseline)", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("poll-change-1", "scope-1", [
      makePollTrigger({ command: `echo baseline`, interval: "10ms", trigger: "change" }),
    ])

    await ensureNoCallDuring(calls, () => Bun.sleep(80))
    AgendaWatcher.stop()
  })

  test("second poll with same output does NOT fire", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("poll-change-2", "scope-1", [
      makePollTrigger({ command: `echo same`, interval: "10ms", trigger: "change" }),
    ])

    await Bun.sleep(50)
    await ensureNoCallDuring(calls, () => Bun.sleep(80))
    AgendaWatcher.stop()
  })

  test("second poll with different output fires handler", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    const tmpFile = path.join(os.tmpdir(), `watcher-test-change-${Date.now()}-${Math.random()}`)
    fs.writeFileSync(tmpFile, "initial")

    try {
      AgendaWatcher.start(handler, [])
      AgendaWatcher.register("poll-change-3", "scope-1", [
        makePollTrigger({
          command: `cat "${tmpFile}"`,
          interval: "10ms",
          trigger: "change",
        }),
      ])

      await Bun.sleep(30)
      expect(calls.length).toBe(0)

      fs.writeFileSync(tmpFile, "changed")
      await waitUntil(() => calls.length >= 1)

      expect(calls[0].signal.type).toBe("watch")
      expect(calls[0].signal.source).toBe("poll-change-3")
      expect(calls[0].signal.payload).toEqual({ output: "changed" })
      expect(calls[0].scopeID).toBe("scope-1")
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
      AgendaWatcher.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// poll — match detection
// ---------------------------------------------------------------------------

describe("poll — match detection", () => {
  test("output matching regex fires handler", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      if (signal.source === "poll-match-1") {
        calls.push({ signal, scopeID })
      }
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("poll-match-1", "scope-1", [
      makePollTrigger({
        command: "echo 'ERROR: something failed'",
        interval: "10ms",
        trigger: "match",
        match: "ERROR",
      }),
    ])

    await waitUntil(() => calls.length >= 1)
    expect(calls[0].signal.type).toBe("watch")
    expect(calls[0].signal.source).toBe("poll-match-1")
    expect((calls[0].signal.payload as Record<string, unknown>).output).toContain("ERROR")
    expect(calls[0].scopeID).toBe("scope-1")
    AgendaWatcher.stop()
  })

  test("output not matching regex does NOT fire handler", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("poll-match-2", "scope-1", [
      makePollTrigger({
        command: `echo 'all good'`,
        interval: "10ms",
        trigger: "match",
        match: "ERROR",
      }),
    ])

    await ensureNoCallDuring(calls, () => Bun.sleep(100))
    AgendaWatcher.stop()
  })
})

// ---------------------------------------------------------------------------
// file — glob matching
// ---------------------------------------------------------------------------

describe("file — glob matching", () => {
  function emitFileEvent(file: string, event: string) {
    GlobalBus.emit("event", {
      payload: { type: "file.watcher.updated", properties: { file, event } },
    })
  }

  test("matching glob and event fires handler", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("file-1", "scope-1", [makeFileTrigger({ glob: "src/**/*.ts" })])

    emitFileEvent("src/foo.ts", "change")

    await waitUntil(() => calls.length === 1)
    expect(calls[0].signal.type).toBe("watch")
    expect(calls[0].signal.source).toBe("file-1")
    expect(calls[0].signal.payload).toEqual({ file: "src/foo.ts", event: "change" })
    expect(calls[0].scopeID).toBe("scope-1")
    AgendaWatcher.stop()
  })

  test("non-matching glob does NOT fire handler", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("file-2", "scope-1", [makeFileTrigger({ glob: "src/**/*.ts" })])

    emitFileEvent("docs/readme.md", "change")

    expect(calls.length).toBe(0)
    await ensureNoCallDuring(calls, () => Bun.sleep(50))
    AgendaWatcher.stop()
  })

  test("event filter rejects non-matching event type", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("file-3", "scope-1", [makeFileTrigger({ glob: "src/**/*.ts", event: "add" })])

    emitFileEvent("src/bar.ts", "change")

    expect(calls.length).toBe(0)
    await ensureNoCallDuring(calls, () => Bun.sleep(50))
    AgendaWatcher.stop()
  })

  test("no event filter debounces rapid file events to the latest event", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("file-4", "scope-1", [makeFileTrigger({ glob: "**/*.css" })])

    emitFileEvent("styles/main.css", "add")
    emitFileEvent("styles/main.css", "change")
    emitFileEvent("styles/main.css", "unlink")

    await waitUntil(() => calls.length === 1)
    expect(calls[0].signal.payload).toEqual({ file: "styles/main.css", event: "unlink" })
    AgendaWatcher.stop()
  })

  test("debounce is per-item not per-file", async () => {
    const calls: Array<{ signal: AgendaTypes.FiredSignal; scopeID: string }> = []
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      calls.push({ signal, scopeID })
    }

    AgendaWatcher.start(handler, [])
    AgendaWatcher.register("file-item-1", "scope-1", [makeFileTrigger({ glob: "**/*.ts" })])
    AgendaWatcher.register("file-item-2", "scope-2", [makeFileTrigger({ glob: "**/*.ts" })])

    emitFileEvent("src/app.ts", "change")

    await waitUntil(() => calls.length === 2)

    const sources = calls.map((c) => c.signal.source).sort()
    const scopeIDs = calls.map((c) => c.scopeID).sort()

    expect(sources).toEqual(["file-item-1", "file-item-2"])
    expect(scopeIDs).toEqual(["scope-1", "scope-2"])
    AgendaWatcher.stop()
  })
})
