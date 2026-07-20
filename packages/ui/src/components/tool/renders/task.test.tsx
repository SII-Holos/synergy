import { describe, expect, mock, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../../tool-title-descriptors"

let registeredRender: ((props: Record<string, any>) => unknown) | undefined
let capturedTrigger: Record<string, unknown> | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({ _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id }),
}))
mock.module("solid-js", () => ({
  createMemo: (fn: () => unknown) => fn,
  For: () => null,
  Show: () => null,
}))
mock.module("../../../context", () => ({
  useData: () => ({ store: { permission: {} } }),
}))
mock.module("../../../hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    handleScroll: () => {},
    scrollRef: undefined,
  }),
}))
mock.module("../../basic-tool", () => ({
  BasicTool: (props: { trigger: Record<string, unknown> }) => {
    capturedTrigger = props.trigger
    return null
  },
}))
mock.module("../../icon", () => ({ Icon: () => null }))
mock.module("../../message-part", () => ({
  ToolRegistry: {
    register: (entry: { render: (props: Record<string, any>) => unknown }) => {
      registeredRender = entry.render
    },
  },
  getToolInfo: () => ({ icon: "settings", title: "Tool" }),
}))

await import("./task")

describe("registered task tool renderer", () => {
  test("uses the shared action title and keeps the agent type as metadata", () => {
    registeredRender?.({
      input: {
        subagent_type: "explore",
        description: "Inspect the tool registry",
      },
      metadata: { background: true },
      tool: "task",
    })

    expect(capturedTrigger).toEqual({
      icon: "list-todo",
      title: TOOL_TITLE_DESC.task,
      subtitle: "Inspect the tool registry",
      tags: [{ label: "explore" }, { label: "background" }],
    })
  })
})
