import { describe, expect, mock, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import type { BasicToolProps } from "../../../src/components/basic-tool"

let capturedTool: BasicToolProps | undefined
let capturedOutput: string | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") {
      return type({ ...(props ?? {}), children: children.length === 1 ? children[0] : children })
    }
    return null
  },
}

mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: BasicToolProps) => {
    capturedTool = props
    return null
  },
  SmartTool: () => null,
  ToolResultPresentationProvider: () => null,
  useToolResultPresentation: () => undefined,
}))
mock.module("../../../src/components/tool-output-text", () => ({
  ToolTextOutput: (props: { text: string }) => {
    capturedOutput = props.text
    return null
  },
}))
mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({ default: "about:blank" }))

const { getToolInfo, ToolRegistry } = await import("../../../src/components/message-part")
await import("../../../src/components/tool/renders/standard")

function resetCapture() {
  capturedTool = undefined
  capturedOutput = undefined
}

describe("Blueprint stop action presentation", () => {
  for (const action of [undefined, "request_review", "pause"] as const) {
    const summary = "Waiting for the missing integration credentials."
    const input = { action, summary }
    const title =
      action === "pause"
        ? { id: "tool.title.pause-session", message: "Pause session" }
        : { id: "tool.title.request-blueprint-review", message: "Request Blueprint Review" }

    test(`${action ?? "default"} keeps trigger metadata action-sensitive and localizable`, () => {
      const info = getToolInfo("blueprint_loop_stop", input)
      expect(info).toMatchObject({ icon: "clipboard-check", title, subtitle: summary })

      const i18n = setupI18n()
      i18n.loadAndActivate({
        locale: "zh-CN",
        messages: {
          "tool.title.pause-session": "暂停会话",
          "tool.title.request-blueprint-review": "请求蓝图评审",
        },
      })
      expect(typeof info.title === "string" ? info.title : i18n._(info.title)).toBe(
        action === "pause" ? "暂停会话" : "请求蓝图评审",
      )
    })

    test(`${action ?? "default"} card preserves the summary and completed receipt`, () => {
      const render = ToolRegistry.render("blueprint_loop_stop")
      expect(render).toBeDefined()

      for (const status of ["running", "completed"] as const) {
        resetCapture()
        const output = `Blueprint execution ${action === "pause" ? "paused" : "ready for review"}.`
        render!({
          tool: "blueprint_loop_stop",
          input,
          status,
          output,
          metadata:
            action === "pause"
              ? {
                  loopID: "loop-fixture",
                  requiredFeatures: ["blueprint"],
                  pauseRequested: true,
                  reviewRequested: false,
                  requiredAgentAction: "end_turn",
                }
              : { reviewRequested: true },
        })

        expect(capturedTool?.trigger).toEqual({ icon: "clipboard-check", title, subtitle: summary })
        expect(capturedTool?.status).toBe(status)
        expect(capturedOutput).toBe(output)
      }
    })
  }
})
