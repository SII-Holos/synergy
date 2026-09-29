import { expect, test } from "bun:test"
import { ComputerRuntime } from "../../src/computer/runtime"

const metadata = {
  snapshot_id: "s12345678",
  elements: [{ element_index: 3 }],
  tree_markdown: "[3] text field Name",
  synergy: { token: "proof", image_status: "unavailable" },
  background_input: { routes: [{ route: "accessibility", status: "available" }] },
}

test("foreground observation verifies activation before capturing the exact window", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const runtime = new ComputerRuntime(async (name, args) => {
    calls.push({ name, args })
    return { content: [], structuredContent: name === "bring_to_front" ? { activated: true } : metadata }
  })
  const result = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20, foreground: true })
  expect(calls.map((call) => call.name)).toEqual(["bring_to_front", "get_window_state"])
  expect(calls[0]?.args).toMatchObject({ pid: 10, window_id: 20 })
  expect(result.metadata.deliveryMode).toBe("foreground")
})

test("partial activation never proceeds to a foreground observation", async () => {
  const calls: string[] = []
  const runtime = new ComputerRuntime(async (name) => {
    calls.push(name)
    return { content: [], structuredContent: { activated: false, request_accepted: true } }
  })
  await expect(
    runtime.execute("task", { type: "observe", pid: 10, windowId: 20, foreground: true }),
  ).rejects.toMatchObject({ code: "computer_foreground_unavailable" })
  expect(calls).toEqual(["bring_to_front"])
})

test("directed AX text and values do not require a process keyboard route", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const runtime = new ComputerRuntime(async (name, args) => {
    calls.push({ name, args })
    return { content: [], structuredContent: metadata }
  })
  for (const action of ["type", "set_value"] as const) {
    const observed = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 })
    const input =
      action === "type"
        ? { action, observationId: observed.observationId!, target: { elementIndex: 3 }, text: "你好" }
        : { action, observationId: observed.observationId!, target: { elementIndex: 3 }, value: "hello" }
    await runtime.execute("task", { type: "action", input })
    expect(calls.at(-1)).toMatchObject({
      name: action === "type" ? "type_text" : "set_value",
      args: { pid: 10, window_id: 20, element_index: 3, snapshot_id: "s12345678" },
    })
  }
})

test("foreground key combinations use Cua once and report the selected delivery", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const runtime = new ComputerRuntime(async (name, args) => {
    calls.push({ name, args })
    return { content: [], structuredContent: metadata }
  })
  const observed = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 })
  const result = await runtime.execute("task", {
    type: "action",
    input: { action: "key", observationId: observed.observationId!, key: "a", modifiers: ["cmd"], foreground: true },
  })
  expect(calls.at(-1)).toMatchObject({ name: "hotkey", args: { keys: ["cmd", "a"], delivery_mode: "foreground" } })
  expect(result.metadata.deliveryMode).toBe("foreground")
  expect(calls).toHaveLength(2)
})

test("foreground input excludes other input across applications until it finishes", async () => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  const runtime = new ComputerRuntime(async (name, args) => {
    if (name === "press_key" && args.pid === 10) {
      entered.resolve()
      await pending.promise
    }
    return { content: [], structuredContent: metadata }
  })
  const a = await runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  const b = await runtime.execute("b", { type: "observe", pid: 11, windowId: 21 })
  const running = runtime.execute("a", {
    type: "action",
    input: { action: "key", observationId: a.observationId!, key: "return", foreground: true },
  })
  await entered.promise
  try {
    await expect(
      runtime.execute("b", {
        type: "action",
        input: { action: "key", observationId: b.observationId!, key: "return" },
      }),
    ).rejects.toMatchObject({ code: "computer_input_busy" })
  } finally {
    pending.resolve()
    await running
  }
})

test("missing Accessibility permits capture but refuses activation and input", async () => {
  const calls: string[] = []
  const runtime = new ComputerRuntime(async (name) => {
    calls.push(name)
    return { content: [], structuredContent: metadata }
  })
  const permissions = { accessibility: false, screen: true }
  const observed = await runtime.execute("a", { type: "observe", pid: 10, windowId: 20 }, undefined, permissions)
  await expect(
    runtime.execute("a", { type: "observe", pid: 10, windowId: 20, foreground: true }, undefined, permissions),
  ).rejects.toMatchObject({ code: "computer_permissions_required" })
  await expect(
    runtime.execute(
      "a",
      { type: "action", input: { action: "key", key: "return", observationId: observed.observationId! } },
      undefined,
      permissions,
    ),
  ).rejects.toMatchObject({ code: "computer_permissions_required" })
  expect(calls).toEqual(["get_window_state"])
})

test("foreground observation retries only a transient capture, never an action", async () => {
  const calls: string[] = []
  const runtime = new ComputerRuntime(async (name) => {
    calls.push(name)
    if (name === "bring_to_front") return { content: [], structuredContent: { activated: true } }
    return {
      content: [],
      structuredContent:
        calls.length === 2
          ? {
              ...metadata,
              screenshot_error: {
                code: "px_capture_unavailable",
                reason: "ScreenCaptureKit: window changed identity while capture was prepared",
              },
            }
          : metadata,
    }
  })
  await runtime.execute("a", { type: "observe", pid: 10, windowId: 20, foreground: true })
  expect(calls).toEqual(["bring_to_front", "get_window_state", "get_window_state"])
})

test("the result preserves native delivery rather than claiming the requested mode", async () => {
  const runtime = new ComputerRuntime(async () => ({
    content: [],
    structuredContent: { ...metadata, delivery: { mode: "background" } },
  }))
  const observed = await runtime.execute("a", { type: "observe", pid: 10, windowId: 20 })
  const result = await runtime.execute("a", {
    type: "action",
    input: { action: "click", observationId: observed.observationId!, target: { elementIndex: 3 }, foreground: true },
  })
  expect(result.metadata.deliveryMode).toBe("background")
})
