import { describe, expect, mock, test } from "bun:test"
import type { BasicToolProps } from "../../../src/components/basic-tool"
import { classifyTool } from "../../../src/components/tool/classifier"

let captured: BasicToolProps | undefined
let output: string | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function")
      return type({ ...(props ?? {}), children: children.length === 1 ? children[0] : children })
    return null
  },
}
mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: BasicToolProps) => {
    captured = props
    return null
  },
  SmartTool: () => null,
  ToolResultPresentationProvider: () => null,
  useToolResultPresentation: () => undefined,
}))
mock.module("../../../src/components/tool-output-text", () => ({
  ToolTextOutput: (props: { text: string }) => {
    output = props.text
    return null
  },
}))
mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({ default: "about:blank" }))
const { getToolInfo, ToolRegistry } = await import("../../../src/components/message-part")
await import("../../../src/components/tool/renders/organization-knowledge")

describe("fixed organization publication observation", () => {
  test("read and search retain their operation, title, file and version", () => {
    const input = { input: { operation: "read", itemID: "publication", version: 3, fileID: "digest" } }
    const metadata = { title: "Guidelines", path: "references/protocol.md", version: 3 }
    expect(getToolInfo("organization_knowledge", input, metadata)).toMatchObject({
      icon: "book-open-text",
      title: { id: "tool.title.organization-knowledge-read", message: "Read organization knowledge" },
      subtitle: "references/protocol.md",
      args: ["v3"],
    })
    expect(classifyTool("organization_knowledge", input, metadata)).toMatchObject({
      category: "file-read",
      subtitle: "references/protocol.md",
      args: ["v3"],
    })
    expect(getToolInfo("organization_knowledge", { input: { operation: "search", q: "handoff" } })).toMatchObject({
      title: { id: "tool.title.organization-knowledge-search", message: "Search organization knowledge" },
      subtitle: "handoff",
    })
  })
  test("ordinary tool card preserves the output and final receipt", () => {
    const render = ToolRegistry.render("organization_knowledge")
    expect(render).toBeDefined()
    render!({
      tool: "organization_knowledge",
      input: { input: { operation: "list" } },
      status: "completed",
      output: "Guidelines · v3",
      metadata: {},
    })
    expect(captured?.trigger).toMatchObject({
      icon: "book-open-text",
      title: { id: "tool.title.organization-knowledge-list" },
    })
    expect(captured?.status).toBe("completed")
    expect(output).toBe("Guidelines · v3")
  })
})
