import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import { createLoopStatusResource } from "../../../src/components/prompt-input/loop-status-resource"

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
function fixture(input: { client?: object; selection?: { features: string[] }; binding?: string | null } = {}) {
  const [owner, setOwner] = createSignal<{ sessionID: string; scopeID: string } | undefined>({
    sessionID: "A",
    scopeID: "home",
  })
  const [loopID, setLoopID] = createSignal<string | undefined>(
    input.binding === null ? undefined : (input.binding ?? "loop-A"),
  )
  const [selection, setSelection] = createSignal(input.selection ?? { features: ["blueprint", "light-loop"] })
  const [reconnect, setReconnect] = createSignal(0)
  const reads: Array<{
    id: string
    signal: AbortSignal
    reply: ReturnType<typeof Promise.withResolvers<BlueprintLoopInfo | undefined>>
  }> = []
  let dispose = () => {}
  const resource = createRoot((close) => {
    dispose = close
    return createLoopStatusResource({
      client: input.client ?? {},
      owner,
      loopID,
      reconnect,
      selection,
      hasFeature: (id) => selection().features.includes(id),
      getBlueprint(id, _scope, signal) {
        const reply = Promise.withResolvers<BlueprintLoopInfo | undefined>()
        reads.push({ id, signal, reply })
        return reply.promise
      },
    })
  })
  return { ...resource, reads, setOwner, setLoopID, setSelection, setReconnect, dispose }
}

test("remount revalidates a still-bound loop once but never restores an unbound cached result", async () => {
  const client = {},
    selection = { features: ["blueprint", "light-loop"] }
  const first = fixture({ client, selection })
  await tick()
  first.reads[0].reply.resolve(blueprint())
  await tick()
  expect(first.blueprint()?.status).toBe("running")
  first.dispose()

  const restored = fixture({ client, selection })
  try {
    await tick()
    expect(restored.reads).toHaveLength(1)
    restored.reads[0].reply.resolve(blueprint("A", "failed"))
    await tick()
    expect(restored.blueprint()?.status).toBe("failed")
  } finally {
    restored.dispose()
  }

  const unbound = fixture({ client, selection, binding: null })
  try {
    await tick()
    expect(unbound.blueprint()).toBeUndefined()
    expect(unbound.reads).toHaveLength(0)
    unbound.retry()
    unbound.setReconnect(1)
    await tick()
    expect(unbound.reads).toHaveLength(0)
    unbound.setLoopID("loop-new")
    await tick()
    expect(unbound.reads).toHaveLength(1)
    expect(unbound.reads[0].id).toBe("loop-new")
    unbound.reads[0].reply.resolve({ ...blueprint(), id: "loop-new" })
    await tick()
    expect(unbound.blueprint()?.id).toBe("loop-new")
  } finally {
    unbound.dispose()
  }
})

test("events beat an older snapshot while unbinding and warm navigation cannot restore them", async () => {
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
    expect(f.blueprint()).toBeUndefined()
    f.setOwner({ sessionID: "B", scopeID: "home" })
    await tick()
    f.setOwner({ sessionID: "A", scopeID: "home" })
    await tick()
    f.update(blueprint("A", "failed"))
    expect(f.blueprint()).toBeUndefined()
    expect(f.reads).toHaveLength(1)
  } finally {
    f.dispose()
  }
})

test("unbinding cancels metadata reads; only a current binding can retry after a read error", async () => {
  const f = fixture()
  try {
    await tick()
    f.setLoopID(undefined)
    await tick()
    expect(f.reads[0].signal.aborted).toBe(true)
    f.reads[0].reply.resolve(blueprint("A", "failed"))
    await tick()
    expect(f.blueprint()).toBeUndefined()
    expect(f.blueprintUnavailable()).toBeUndefined()
    f.retry()
    await tick()
    expect(f.reads).toHaveLength(1)

    f.setLoopID("loop-A")
    await tick()
    f.reads[1].reply.reject(new Error("offline"))
    await tick()
    expect(f.blueprintUnavailable()).toBe(true)
    await tick()
    expect(f.reads).toHaveLength(2)
    f.retry()
    await tick()
    expect(f.reads).toHaveLength(3)
    f.reads[2].reply.resolve(blueprint())
    await tick()
    expect(f.blueprint()?.status).toBe("running")
    expect(f.blueprintUnavailable()).toBe(false)
    f.setOwner(undefined)
    await tick()
    expect(() => f.retry()).not.toThrow()
  } finally {
    f.dispose()
  }
})

test("an old loop reply or event cannot displace the current binding or resurrect a cleared one", async () => {
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
    f.update({ ...blueprint("A", "failed"), id: "loop-next", time: { created: 1, updated: 20 } })
    f.update({ ...blueprint("A", "completed"), id: "loop-next", time: { created: 1, updated: 10 } })
    expect(f.blueprint()?.status).toBe("failed")
    f.setLoopID(undefined)
    await tick()
    f.update({ ...blueprint("A", "completed"), time: { created: 1, updated: 30 } })
    expect(f.blueprint()).toBeUndefined()
    expect(f.reads).toHaveLength(2)
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

test("reconnect revalidates only current bindings and rejects the previous epoch reply", async () => {
  const f = fixture()
  try {
    await tick()
    f.reads[0].reply.resolve(blueprint())
    await tick()
    f.setReconnect(1)
    await tick()
    const obsolete = f.reads.at(-1)!
    f.setReconnect(2)
    await tick()
    expect(obsolete.signal.aborted).toBe(true)
    f.reads.at(-1)!.reply.resolve(blueprint("A", "failed"))
    obsolete.reply.resolve(blueprint("A", "completed"))
    await tick()
    expect(f.blueprint()?.status).toBe("failed")
    f.setLoopID(undefined)
    await tick()
    const reads = f.reads.length
    f.setReconnect(3)
    await tick()
    expect(f.reads).toHaveLength(reads)
    expect(f.blueprint()).toBeUndefined()
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
