import { expect, test } from "bun:test"
import { ComputerRuntime } from "../../src/computer/runtime"
import { createHash } from "node:crypto"

function degraded(metadata: Record<string, unknown>) {
  const calls: string[] = []
  const runtime = new ComputerRuntime(async (name) => {
    calls.push(name)
    return { content: [], structuredContent: metadata }
  })
  return { runtime, calls }
}

test("a native screenshot rejection never grants a point action", async () => {
  const { runtime, calls } = degraded({
    snapshot_id: "s12345678",
    tree_markdown: "[0] button Save",
    screenshot_frame_valid: false,
    elements: [{ element_index: 0 }],
  })
  const result = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 })
  await expect(
    runtime.execute("task", {
      type: "action",
      input: { action: "point", observationId: result.observationId!, x: 400, y: 400 },
    }),
  ).rejects.toMatchObject({ code: "computer_action_unavailable" })
  expect(calls).toEqual(["get_window_state"])
})

test("an observation with neither channel cannot grant input", async () => {
  const { runtime, calls } = degraded({ elements: [], screenshot_frame_valid: false })
  const result = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 })
  await expect(
    runtime.execute("task", {
      type: "action",
      input: { action: "key", observationId: result.observationId!, key: "return" },
    }),
  ).rejects.toMatchObject({ code: "computer_action_unavailable" })
  expect(calls).toEqual(["get_window_state"])
})

test("observation text contains one AX representation within a UTF-8 budget", async () => {
  const tree = Array.from({ length: 1000 }, (_, i) => `[${i}] button 保存${"文".repeat(40)}`).join("\n")
  const runtime = new ComputerRuntime(async () => ({
    content: [{ type: "text", text: tree }],
    structuredContent: { snapshot_id: "s12345678", tree_markdown: tree, elements: [] },
  }))
  const result = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 })
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32 * 1024)
  expect(result.output.match(/\[0\] button/g)).toHaveLength(1)
  expect(result.output).toContain("query")
})

test("image point admission binds sent bytes, pixel bounds and the native capture", async () => {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6j8AAAAASUVORK5CYII="
  const sha256 = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const runtime = new ComputerRuntime(async (name, args) => {
    calls.push({ name, args })
    return {
      content: [{ type: "image", mimeType: "image/png", data }],
      structuredContent: {
        capture_id: "capture-exact",
        screenshot_frame_valid: true,
        synergy: { token: "proof", image_status: "valid", sha256, width: 1, height: 1 },
        background_input: { routes: [{ route: "window_pointer", status: "available" }] },
      },
    }
  })
  for (const mode of ["missing", "wrong", "outside", "valid"] as const) {
    const observed = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 })
    const action = runtime.execute("task", {
      type: "action",
      input: { action: "point", observationId: observed.observationId!, x: mode === "outside" ? 1 : 0, y: 0 },
      ...(mode === "missing"
        ? {}
        : { imageReceipt: { callID: "current-call", sha256: [mode === "wrong" ? "0".repeat(64) : sha256] } }),
    })
    if (mode === "valid") await action
    else
      await expect(action).rejects.toMatchObject({
        code: mode === "outside" ? "computer_point_out_of_bounds" : "computer_image_not_delivered",
      })
  }
  expect(calls.filter((call) => call.name === "click")).toEqual([
    {
      name: "click",
      args: expect.objectContaining({
        capture_id: "capture-exact",
        synergy_guard: "proof",
        x: 0,
        y: 0,
        delivery_mode: "background",
      }),
    },
  ])
})

test("AX-only observation preserves semantic routes and forwards independent grants", async () => {
  let args: Record<string, unknown> = {}
  const runtime = new ComputerRuntime(async (_name, input) => {
    args = input
    return {
      content: [],
      structuredContent: {
        snapshot_id: "s12345678",
        tree_markdown: "[0] button Save",
        elements: [{ element_index: 0 }],
        truncated: true,
        synergy: { token: "proof", image_status: "unavailable" },
        background_input: { routes: [{ route: "accessibility", status: "available" }] },
      },
    }
  })
  const result = await runtime.execute("task", { type: "observe", pid: 10, windowId: 20 }, undefined, {
    accessibility: true,
    screen: false,
  })
  expect(args).toMatchObject({ include_screenshot: false, include_accessibility_tree: true })
  expect(result.metadata.computerObservation).toMatchObject({
    ax: { truncated: true },
    actions: { click: { available: true }, point: { available: false } },
  })
  await expect(
    runtime.execute("task", {
      type: "action",
      input: { action: "click", observationId: result.observationId!, elementIndex: 0 },
    }),
  ).resolves.toHaveProperty("output")
})
