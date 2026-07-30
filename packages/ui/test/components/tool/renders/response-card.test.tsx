import { describe, expect, mock, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../../../../src/components/tool-title-descriptors"

let registeredName: string | undefined
let registeredRender: ((props: Record<string, any>) => unknown) | undefined
let capturedTrigger: Record<string, unknown> | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({
    _: (descriptor: { id: string; message?: string; values?: { count?: number } }) => {
      if (descriptor.id === "tool.label.elements") {
        const count = descriptor.values?.count ?? 0
        return `${count} ${count === 1 ? "element" : "elements"}`
      }
      return descriptor.message ?? descriptor.id
    },
  }),
}))
mock.module("solid-js", () => ({ Show: () => null }))
mock.module("../../../../src/components/basic-tool", () => ({
  BasicTool: (props: { trigger: Record<string, unknown> }) => {
    capturedTrigger = props.trigger
    return null
  },
}))
mock.module("../../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
      registeredName = entry.name
      registeredRender = entry.render
    },
  },
}))
mock.module("../../../../src/components/tool-output-text", () => ({ ToolTextOutput: () => null }))

await import("../../../../src/components/tool/renders/response-card")

describe("registered response_card renderer", () => {
  test("uses localized card chrome without simulating Channel interaction", () => {
    registeredRender?.({
      input: {
        title: "Choose a release path",
        elements: [
          { type: "text", text: "Select how to continue." },
          { type: "button", id: "approve", label: "Approve", value: "approve" },
        ],
      },
      output: "Prepared a response card for Channel delivery.",
      tool: "response_card",
    })

    expect(registeredName).toBe("response_card")
    expect(capturedTrigger).toEqual({
      icon: "message-square-more",
      title: TOOL_TITLE_DESC.response_card,
      subtitle: "Choose a release path",
      tags: [{ label: "2 elements" }],
    })
  })
})
