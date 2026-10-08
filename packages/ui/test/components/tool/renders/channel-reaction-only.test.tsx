import { describe, expect, mock, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../../../../src/components/tool-title-descriptors"

let registeredName: string | undefined
let registeredRender: ((props: Record<string, any>) => unknown) | undefined
let capturedTrigger: Record<string, unknown> | undefined

// Read through a function so TypeScript does not narrow the closure variable.
function trigger(): Record<string, unknown> | undefined {
  return capturedTrigger
}

;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({
    _: (descriptor: { id: string; message?: string }) => descriptor.message ?? descriptor.id,
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

await import("../../../../src/components/tool/renders/channel-reaction-only")

describe("registered channel_reaction_only renderer", () => {
  test("uses localized chrome with the chosen reaction as subtitle", () => {
    registeredRender?.({
      input: { reaction: "SILENT" },
      output: 'Ending this turn with the "SILENT" reaction and no other delivery.',
      tool: "channel_reaction_only",
    })

    expect(registeredName).toBe("channel_reaction_only")
    expect(trigger()).toEqual({
      icon: "message-square-more",
      title: TOOL_TITLE_DESC.channel_reaction_only,
      subtitle: "SILENT",
    })
  })

  test("omits the subtitle when the tool used the account default", () => {
    capturedTrigger = undefined
    registeredRender?.({
      input: {},
      output: 'Ending this turn with the "SILENT" reaction and no other delivery.',
      tool: "channel_reaction_only",
    })

    expect(trigger()?.["icon"]).toBe("message-square-more")
    expect(trigger()?.["title"]).toBe(TOOL_TITLE_DESC.channel_reaction_only)
    expect(trigger()?.["subtitle"]).toBeUndefined()
  })
})
