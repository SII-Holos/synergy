import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import { createLoopStatusResource } from "../../../src/components/prompt-input/loop-status-resource"
import type { LoopHistoryHint, LoopTerminal } from "../../../src/components/prompt-input/loop-status"

const tick = () => Bun.sleep(0)
const blueprint = (sessionID = "A", status: BlueprintLoopInfo["status"] = "running"): BlueprintLoopInfo => ({
  id: `loop-${sessionID}`,
  sessionID,
  scopeID: "home",
  title: sessionID,
  noteID: "note",
  source: "user",
  status,
  auditAgent: "supervisor",
  time: { created: 1, updated: status === "running" ? 1 : 2 },
})
function fixture(
  input: {
    client?: object
    selection?: { features: string[] }
    binding?: string | null
    history?: LoopHistoryHint
  } = {},
) {
  const [owner, setOwner] = createSignal<{ sessionID: string; scopeID: string } | undefined>({
    sessionID: "A",
    scopeID: "home",
  })
  const [loopID, setLoopID] = createSignal<string | undefined>(
    input.binding === null ? undefined : (input.binding ?? "loop-A"),
  )
  const [lightActive, setLightActive] = createSignal(false)
  const [history, setHistory] = createSignal<LoopHistoryHint>(input.history ?? {})
  const [lightReviewer, setLightReviewer] = createSignal<string>()
  const [selection, setSelection] = createSignal(input.selection ?? { features: ["blueprint", "light-loop"] })
  const [reconnect, setReconnect] = createSignal(0)
  const reads: Array<{
    id: string
    signal: AbortSignal
    reply: ReturnType<typeof Promise.withResolvers<BlueprintLoopInfo | undefined>>
  }> = []
  const terminals: Array<{
    id: string
    signal: AbortSignal
    reply: ReturnType<typeof Promise.withResolvers<LoopTerminal | undefined>>
  }> = []
  let dispose = () => {}
  const resource = createRoot((close) => {
    dispose = close
    return createLoopStatusResource({
      client: input.client ?? {},
      owner,
      loopID,
      lightActive,
      history,
      lightReviewer,
      reconnect,
      selection,
      hasFeature: (id) => selection().features.includes(id),
      getBlueprint(id, _scope, signal) {
        const reply = Promise.withResolvers<BlueprintLoopInfo | undefined>()
        reads.push({ id, signal, reply })
        return reply.promise
      },
      getTerminal(id, _scope, signal) {
        const reply = Promise.withResolvers<LoopTerminal | undefined>()
        terminals.push({ id, signal, reply })
        return reply.promise
      },
    })
  })
  return {
    setLightReviewer,
    ...resource,
    reads,
    terminals,
    setOwner,
    setLoopID,
    setLightActive,
    setHistory,
    setSelection,
    setReconnect,
    dispose,
  }
}

test("remount revalidates an unfinished cached loop once but retains a confirmed terminal result", async () => {
  const client = {},
    selection = { features: ["blueprint", "light-loop"] }
  const first = fixture({ client, selection })
  await tick()
  first.reads[0].reply.resolve(blueprint())
  await tick()
  expect(first.blueprint()?.status).toBe("running")
  first.dispose()

  const restored = fixture({ client, selection, binding: null, history: { blueprintID: "loop-A" } })
  try {
    await tick()
    expect(restored.reads).toHaveLength(1)
    restored.setHistory({ blueprintID: "loop-A" })
    await tick()
    expect(restored.reads).toHaveLength(1)
    restored.reads[0].reply.resolve(blueprint("A", "failed"))
    await tick()
    expect(restored.blueprint()?.status).toBe("failed")
  } finally {
    restored.dispose()
  }

  const terminal = fixture({ client, selection, binding: null, history: { blueprintID: "loop-A" } })
  try {
    await tick()
    expect(terminal.blueprint()?.status).toBe("failed")
    expect(terminal.reads).toHaveLength(0)
    terminal.setLoopID("loop-new")
    await tick()
    expect(terminal.reads).toHaveLength(1)
  } finally {
    terminal.dispose()
  }

  const pending = fixture({ client, selection, binding: "loop-new", history: { blueprintID: "loop-A" } })
  try {
    await tick()
    expect(pending.reads).toHaveLength(1)
    expect(pending.reads[0].id).toBe("loop-new")
    pending.reads[0].reply.resolve({ ...blueprint(), id: "loop-new" })
    await tick()
    expect(pending.blueprint()?.id).toBe("loop-new")
  } finally {
    pending.dispose()
  }
})

test("events retain terminal results, warm switching reads nothing, and an older snapshot cannot undo review", async () => {
  const f = fixture()
  try {
    await tick()
    f.update(blueprint("A", "auditing"))
    f.reads[0].reply.resolve(blueprint())
    await tick()
    expect(f.blueprint()?.status).toBe("auditing")
    f.update(blueprint("A", "completed"))
    f.setLoopID(undefined)
    await tick()
    expect(f.blueprint()?.status).toBe("completed")
    f.setOwner({ sessionID: "B", scopeID: "home" })
    await tick()
    expect(f.blueprint()).toBeUndefined()
    f.setOwner({ sessionID: "A", scopeID: "home" })
    await tick()
    expect(f.blueprint()?.status).toBe("completed")
    expect(f.reads).toHaveLength(1)
    expect(f.terminals).toHaveLength(0)
  } finally {
    f.dispose()
  }
})

test("losing a running binding reads once, shares history updates, and retries only explicitly", async () => {
  const f = fixture()
  try {
    await tick()
    f.reads[0].reply.resolve(blueprint())
    await tick()
    f.setLoopID(undefined)
    f.setHistory({ blueprintID: "loop-A" })
    await tick()
    expect(f.reads).toHaveLength(2)
    f.setHistory({ blueprintID: "loop-A" })
    await tick()
    expect(f.reads).toHaveLength(2)
    expect(f.reads[1].signal.aborted).toBe(false)
    f.reads[1].reply.reject(new Error("offline"))
    await tick()
    expect(f.blueprintUnavailable()).toBe(true)
    await tick()
    expect(f.reads).toHaveLength(2)
    f.retry()
    await tick()
    expect(f.reads).toHaveLength(3)
    f.reads[2].reply.resolve(blueprint("A", "failed"))
    await tick()
    expect(f.blueprint()?.status).toBe("failed")
    expect(f.blueprintUnavailable()).toBe(false)
  } finally {
    f.dispose()
  }
})

test("an old loop reply or event cannot displace the current binding", async () => {
  const f = fixture()
  try {
    await tick()
    f.setLoopID("loop-next")
    await tick()
    expect(f.reads[0].signal.aborted).toBe(true)
    f.update(blueprint("A", "failed"))
    f.reads[0].reply.resolve(blueprint())
    await tick()
    expect(f.blueprint()).toBeUndefined()
    f.reads[1].reply.resolve({ ...blueprint(), id: "loop-next", title: "Next" })
    await tick()
    expect(f.blueprint()).toMatchObject({ id: "loop-next", title: "Next", status: "running" })
    expect(f.reads).toHaveLength(2)
    f.update({ ...blueprint("A", "failed"), id: "loop-next", time: { created: 1, updated: 20 } })
    f.setLoopID(undefined)
    f.setHistory({ blueprintID: "loop-next" })
    await tick()
    f.update({ ...blueprint("A", "completed"), time: { created: 1, updated: 10 } })
    expect(f.blueprint()).toMatchObject({ id: "loop-next", status: "failed" })
  } finally {
    f.dispose()
  }
})

test("a late old owner and removed capability cannot populate the target view", async () => {
  const f = fixture()
  try {
    await tick()
    f.setOwner({ sessionID: "B", scopeID: "other" })
    f.setLoopID("loop-B")
    await tick()
    f.reads[0].reply.resolve(blueprint())
    await tick()
    expect(f.blueprint()).toBeUndefined()
    f.setSelection({ features: [] })
    await tick()
    const last = f.reads.at(-1)!
    expect(last.signal.aborted).toBe(true)
    last.reply.resolve({ ...blueprint("B"), scopeID: "other" })
    await tick()
    expect(f.blueprint()).toBeUndefined()
  } finally {
    f.dispose()
  }
})

test("Light Loop reads its authoritative terminal once, never polls or treats clearing as approval", async () => {
  const f = fixture()
  try {
    f.setLoopID(undefined)
    f.setLightActive(true)
    await tick()
    expect(f.terminals).toHaveLength(0)
    f.setLightActive(false)
    await tick()
    expect(f.terminal()).toBeUndefined()
    expect(f.terminals).toHaveLength(1)
    f.terminals[0].reply.resolve({
      status: "failed",
      instructions: "Task",
      error: "Review could not start",
      createdAt: 3,
    })
    await tick()
    expect(f.terminal()).toMatchObject({ status: "failed", error: "Review could not start" })
    f.setOwner({ sessionID: "B", scopeID: "home" })
    await tick()
    f.setOwner({ sessionID: "A", scopeID: "home" })
    await tick()
    expect(f.terminal()?.status).toBe("failed")
    expect(f.terminals).toHaveLength(1)
    f.setLightActive(true)
    await tick()
    expect(f.terminal()).toBeUndefined()
    f.setLightActive(false)
    await tick()
    expect(f.terminals).toHaveLength(2)
    f.setLightActive(true)
    await tick()
    f.terminals[1].reply.resolve({ status: "completed", instructions: "Old task", createdAt: 4 })
    await tick()
    expect(f.terminal()).toBeUndefined()
  } finally {
    f.dispose()
  }
})

test("loaded history metadata recovers a result without loading message bodies; reconnect revalidates", async () => {
  const f = fixture()
  try {
    f.setLoopID(undefined)
    f.setHistory({ blueprintID: "loop-A", light: "notice" })
    await tick()
    f.reads.at(-1)!.reply.resolve(blueprint("A", "failed"))
    f.terminals.at(-1)!.reply.resolve({ status: "cancelled", instructions: "Task", createdAt: 5 })
    await tick()
    expect(f.blueprint()?.status).toBe("failed")
    expect(f.terminal()?.status).toBe("cancelled")
    const before = [f.reads.length, f.terminals.length]
    f.setReconnect(1)
    await tick()
    expect([f.reads.length, f.terminals.length]).toEqual(before.map((count) => count + 1))
    const obsolete = f.reads.at(-1)!
    f.setReconnect(2)
    await tick()
    expect(obsolete.signal.aborted).toBe(true)
    f.reads.at(-1)!.reply.resolve(blueprint("A", "failed"))
    obsolete.reply.resolve(blueprint("A", "completed"))
    await tick()
    expect(f.blueprint()?.status).toBe("failed")
  } finally {
    f.dispose()
  }
})

test("residency is bounded and disposal cancels pending reads", async () => {
  const f = fixture()
  try {
    await tick()
    for (let index = 0; index < 40; index++) {
      const id = `s${index}`
      f.setLoopID(undefined)
      f.setOwner({ sessionID: id, scopeID: "home" })
      f.setLoopID(`loop-${id}`)
      await tick()
      f.reads.at(-1)!.reply.resolve(blueprint(id))
      await tick()
    }
    f.setLoopID(undefined)
    f.setOwner({ sessionID: "A", scopeID: "home" })
    f.setLoopID("loop-A")
    await tick()
    expect(f.reads.at(-1)?.id).toBe("loop-A")
    const request = f.reads.at(-1)!
    f.dispose()
    expect(request.signal.aborted).toBe(true)
  } finally {
    f.dispose()
  }
})

test("a failed cold result read stays visible and retries only on request", async () => {
  const f = fixture()
  try {
    f.setLoopID(undefined)
    f.setHistory({ light: "terminal-notice" })
    await tick()
    expect(f.awaitingTerminal()).toBeUndefined()
    f.terminals[0].reply.reject(new Error("offline"))
    await tick()
    expect(f.awaitingTerminal()?.error).toBe(true)
    expect(f.terminal()).toBeUndefined()
    await tick()
    expect(f.terminals).toHaveLength(1)
    f.retry()
    await tick()
    expect(f.terminals).toHaveLength(2)
    expect(f.awaitingTerminal()?.error).toBe(false)
    f.terminals[1].reply.resolve({ status: "cancelled", instructions: "Task", createdAt: 5 })
    await tick()
    expect(f.terminal()?.status).toBe("cancelled")
    f.setOwner(undefined)
    await tick()
    expect(() => f.retry()).not.toThrow()
  } finally {
    f.dispose()
  }
})

test("a late approval notice shares the terminal read but a new unseen review refreshes it", async () => {
  const f = fixture()
  try {
    f.setLoopID(undefined)
    f.setLightActive(true)
    f.setHistory({ light: "start" })
    f.setLightReviewer("review-A")
    await tick()
    f.setLightActive(false)
    await tick()
    expect(f.terminals).toHaveLength(1)
    f.setHistory({ light: "approved-A", lightReview: "review-A" })
    await tick()
    expect(f.terminals).toHaveLength(1)
    expect(f.terminals[0].signal.aborted).toBe(false)
    f.terminals[0].reply.resolve({ status: "completed", instructions: "Task A", createdAt: 5 })
    await tick()
    f.setHistory({ light: "approved-B", lightReview: "review-B" })
    await tick()
    expect(f.terminals).toHaveLength(2)
    f.terminals[1].reply.resolve({ status: "failed", instructions: "Task B", createdAt: 8 })
    await tick()
    expect(f.terminal()?.instructions).toBe("Task B")
  } finally {
    f.dispose()
  }
})

test("a deduplicated terminal read still releases its owner on navigation", async () => {
  const f = fixture()
  try {
    f.setLoopID(undefined)
    f.setLightActive(true)
    f.setHistory({ light: "start" })
    f.setLightReviewer("review-A")
    await tick()
    f.setLightActive(false)
    await tick()
    f.setHistory({ light: "approved-A", lightReview: "review-A" })
    await tick()
    f.setOwner(undefined)
    f.setHistory({})
    await tick()
    expect(f.terminals[0].signal.aborted).toBe(true)
    f.terminals[0].reply.resolve({ status: "completed", instructions: "Task A", createdAt: 5 })
    await tick()
    expect(f.terminal()).toBeUndefined()
  } finally {
    f.dispose()
  }
})
