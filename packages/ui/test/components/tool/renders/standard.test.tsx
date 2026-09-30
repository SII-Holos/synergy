import { describe, expect, mock, test } from "bun:test"

let registeredRenders: Record<string, (props: Record<string, any>) => unknown> = {}
let capturedTrigger: Record<string, unknown> | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({
    _: (descriptor: { id: string; message?: string }) => descriptor.message,
  }),
}))
mock.module("solid-js", () => ({
  createMemo: (fn: () => unknown) => fn,
  For: () => null,
  Show: () => null,
}))
mock.module("../../../../src/context", () => ({
  useData: () => ({ store: { permission: {} } }),
}))
mock.module("../../../../src/hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    handleScroll: () => {},
    scrollRef: undefined,
  }),
  createAnimatedNumber: () => 0,
}))
mock.module("../../../../src/components/basic-tool", () => ({
  BasicTool: (props: { trigger: Record<string, unknown> }) => {
    capturedTrigger = props.trigger
    return null
  },
  SmartTool: () => null,
}))
mock.module("../../../../src/components/icon", () => ({ Icon: () => null }))
mock.module("../../../../src/components/checkbox", () => ({ Checkbox: () => null }))
mock.module("../../../../src/components/render-html", () => ({ RenderHtml: () => null }))
let capturedGalleryFiles: unknown[] | undefined
const lastGalleryFiles = () => capturedGalleryFiles
mock.module("../../../../src/components/attachment-card", () => ({
  AttachmentGallery: (props: { files: unknown[] }) => {
    capturedGalleryFiles = props.files
    return null
  },
}))
mock.module("../../../../src/components/tool-output-text", () => ({ ToolTextOutput: () => null }))
mock.module("../../../../src/components/semantic-icon", () => ({ getSemanticIcon: (name: string) => name }))
mock.module("@ericsanchezok/synergy-sdk", () => ({}))
mock.module("../../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
      registeredRenders[entry.name] = entry.render
    },
  },
  getToolInfo: () => ({ icon: "settings", title: "Tool" }),
  getDirectory: (path: string) => path,
}))

await import("../../../../src/components/tool/renders/standard")

function renderTrigger(tool: string, props: Record<string, any>) {
  registeredRenders[tool]?.(props)
  return capturedTrigger
}

describe("bash and process cards", () => {
  test("bash card shows its command", () => {
    const result = renderTrigger("bash", { input: { command: "ls" }, metadata: {} })
    expect(result?.tags).toEqual([{ label: "ls" }])
  })

  test("process card shows no execution-origin marker", () => {
    const result = renderTrigger("process", { input: { action: "list" }, metadata: {} })
    expect(result?.tags).toBeUndefined()
  })
})
