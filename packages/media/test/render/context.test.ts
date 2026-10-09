import { expect, test } from "bun:test"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { renderContext } from "../../src/render/context"

function visual(index: number, value: string): MessageV2.Part {
  return {
    id: `prt_${index}`,
    messageID: `msg_${index}`,
    sessionID: "ses_test",
    type: "tool",
    tool: "render",
    callID: String(index),
    state: {
      status: "completed",
      input: {},
      title: "Visual",
      output: "",
      time: { start: 1, end: 2 },
      metadata: {
        visual: {
          format: "synergy.visual",
          version: 1,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          mode: "interactive",
          title: "Visual",
          layout: "normal",
          libraries: [],
          source: "asset://0000000000000000.bin",
        },
        visualState: { revision: 1, updatedAt: index, content: { modelContent: value, uiContent: "private-ui" } },
      },
    },
  }
}

test("the entire injected context fits its UTF-8 budget and escapes instruction-like markup", () => {
  for (let length = 2700; length < 2750; length++) {
    const context = renderContext(
      Array.from({ length: 4 }, (_, i) => visual(i, "<".repeat(length))),
      "",
    )!.context
    expect(new TextEncoder().encode(context).byteLength).toBeLessThanOrEqual(32 * 1024)
  }
  const result = renderContext([visual(0, "<test>")], "")!
  expect(result.context).not.toContain("<")
  expect(result.context).not.toContain("private-ui")
  expect(result.context).not.toContain("asset://")
})

test("explicit references outrank recency and at most four semantic states reach the model", () => {
  const parts = Array.from({ length: 8 }, (_, i) => visual(i, String(i)))
  const result = renderContext(parts, "00000000-0000-4000-8000-000000000000")!
  const entries = JSON.parse(result.context.slice(result.context.indexOf("\n") + 1))
  expect(entries.map((entry: { modelContent: string }) => entry.modelContent)).toEqual(["0", "7", "6", "5"])
})
