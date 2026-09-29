import { expect, test } from "bun:test"
import { ComputerRuntime } from "../../src/computer/runtime"

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
