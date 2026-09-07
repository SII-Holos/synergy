import { expect, mock, test } from "bun:test"

const registrations = new Map<string, (props: Record<string, unknown>) => unknown>()
let card: Record<string, unknown> | undefined
let output: unknown
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    return typeof type === "function" ? type({ ...props, children }) : null
  },
}
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: () => "" }) }))
mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: Record<string, unknown>) => {
    card = props
    return null
  },
}))
mock.module("../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, unknown>) => unknown }) =>
      registrations.set(entry.name, entry.render),
  },
}))
mock.module("../../../src/components/tool/body-primitives", () => ({
  RawOutput: (props: { output: unknown }) => {
    output = props.output
    return null
  },
}))
for (const name of ["file-ops", "standard", "task", "dag", "browser", "anysearch", "scholight", "batch"])
  mock.module(`../../../src/components/tool/renders/${name}`, () => ({}))
await import("../../../src/components/tool-renders")

test("the standard render bundle registers native tools and preserves status, output and attachments", () => {
  for (const name of ["computer_apps", "computer_observe", "computer_action"]) {
    const render = registrations.get(name)
    expect(render).toBeDefined()
    const props = {
      input: { input: { action: "type", text: "private value" } },
      output: "Native result",
      status: "completed",
      attachments: [{ mime: "image/png" }],
    }
    render!(props)
    expect(card?.status).toBe("completed")
    expect(card?.attachments).toBe(props.attachments)
    expect(output).toBe("Native result")
    expect(JSON.stringify(card?.trigger)).not.toContain("private value")
  }
})
