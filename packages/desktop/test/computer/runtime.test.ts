import { expect, test } from "bun:test"
import { ComputerRuntime } from "../../src/computer/runtime"

function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const runtime = new ComputerRuntime(async (name, args) => {
    calls.push({ name, args })
    return {
      content: [{ type: "text", text: "observed" }],
      structuredContent: { snapshot_id: "s12345678", elements: [{ element_index: 0 }], windows: [] },
    }
  })
  return { runtime, calls }
}

test("actions bind to the owning task and latest exact window observation", async () => {
  const { runtime, calls } = fixture()
  const observed = await runtime.execute("task-a", { type: "observe", pid: 10, windowId: 20 })
  await expect(
    runtime.execute("task-b", {
      type: "action",
      input: { action: "click", observationId: observed.observationId!, elementIndex: 0 },
    }),
  ).rejects.toThrow("Observe")
  await runtime.execute("task-a", {
    type: "action",
    input: { action: "click", observationId: observed.observationId!, elementIndex: 0 },
  })
  expect(calls.at(-1)).toEqual({
    name: "click",
    args: expect.objectContaining({
      pid: 10,
      window_id: 20,
      snapshot_id: "s12345678",
      element_index: 0,
      delivery_mode: "background",
    }),
  })
  await expect(
    runtime.execute("task-a", {
      type: "action",
      input: { action: "click", observationId: observed.observationId!, elementIndex: 0 },
    }),
  ).rejects.toThrow("Observe")
})

test("a new observation invalidates older references even for another task on that window", async () => {
  const { runtime } = fixture()
  const a = await runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  await runtime.execute("b", { type: "observe", pid: 10, windowId: 20 })
  await expect(
    runtime.execute("a", { type: "action", input: { action: "key", key: "return", observationId: a.observationId! } }),
  ).rejects.toThrow("Observe")
})

test("different applications can execute concurrently", async () => {
  let unblock!: () => void
  const blocker = new Promise<void>((r) => (unblock = r))
  const runtime = new ComputerRuntime(async (_name, args) => {
    if (args.pid === 10) await blocker
    return { content: [], structuredContent: { snapshot_id: "s12345678" } }
  })
  const a = runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  expect((await runtime.execute("b", { type: "observe", pid: 11, windowId: 21 })).observationId).toBeTruthy()
  unblock()
  await a
})

test("native errors remain errors and never retry an action", async () => {
  const { runtime, calls } = fixture()
  const a = await runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  await runtime.execute("a", { type: "release" })
  await expect(
    runtime.execute("a", { type: "action", input: { action: "key", key: "return", observationId: a.observationId! } }),
  ).rejects.toThrow("Observe")
  expect(calls.filter((x) => x.name === "press_key")).toHaveLength(0)
})

test("native failure consumes the action reference without replay", async () => {
  let attempts = 0
  const runtime = new ComputerRuntime(async (name) => {
    if (name === "get_window_state") return { content: [], structuredContent: { snapshot_id: "s12345678" } }
    attempts++
    return { isError: true, content: [{ type: "text", text: "background_unavailable" }] }
  })
  const observed = await runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  const command = {
    type: "action",
    input: { action: "key", key: "return", observationId: observed.observationId! },
  } as const
  await expect(runtime.execute("a", command)).rejects.toThrow("background_unavailable")
  await expect(runtime.execute("a", command)).rejects.toThrow("Observe")
  expect(attempts).toBe(1)
})

test("overlapping calls on the same process are refused without a desktop-wide lease", async () => {
  let unblock!: () => void
  const barrier = new Promise<void>((resolve) => (unblock = resolve))
  const runtime = new ComputerRuntime(async () => {
    await barrier
    return { content: [], structuredContent: { snapshot_id: "s12345678" } }
  })
  const first = runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  await expect(runtime.execute("b", { type: "observe", pid: 10, windowId: 21 })).rejects.toThrow("application")
  unblock()
  await first
})
