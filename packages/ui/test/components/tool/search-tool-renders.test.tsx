import { beforeEach, describe, expect, mock, test } from "bun:test"

const registrations = new Map<string, (props: Record<string, any>) => unknown>()
let capturedTrigger: Record<string, unknown> | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return null
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({
    _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id,
  }),
}))
mock.module("solid-js", () => ({
  createMemo: (fn: () => unknown) => fn,
  For: () => null,
  Show: () => null,
}))
mock.module("../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
      registrations.set(entry.name, entry.render)
    },
  },
}))
mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: { trigger: Record<string, unknown> }) => {
    capturedTrigger = props.trigger
    return null
  },
}))
mock.module("../../../src/components/spinner", () => ({ Spinner: () => null }))
mock.module("../../../src/components/tool-output-text", () => ({ ToolTextOutput: () => null }))

await import("../../../src/components/tool/renders/anysearch")
await import("../../../src/components/tool/renders/scholight")

function render(name: string, props: Record<string, any>) {
  capturedTrigger = undefined
  registrations.get(name)?.({
    tool: name,
    input: {},
    metadata: {},
    ...props,
  })
}

beforeEach(() => {
  capturedTrigger = undefined
})

describe("remote MCP search renderer registration (render boundaries)", () => {
  test("resolves every canonical anysearch and scholight id", () => {
    expect([...registrations.keys()].toSorted()).toEqual([
      "mcp__anysearch__batch_search",
      "mcp__anysearch__extract",
      "mcp__anysearch__get_sub_domains",
      "mcp__anysearch__search",
      "mcp__scholight__extract_url",
      "mcp__scholight__search_papers",
    ])
  })

  test("anysearch search trigger carries orbit icon, query subtitle and domain tags", () => {
    render("mcp__anysearch__search", {
      input: { query: "vector databases", domains: ["github.com"], max_results: 5 },
      output: "…",
      status: "completed",
    })
    expect(capturedTrigger).toEqual({
      icon: "orbit",
      title: "Anysearch",
      subtitle: "vector databases",
      tags: [{ label: "github.com" }, { label: "5 results" }],
    })
  })

  test("anysearch batch_search trigger summarizes the query count in every state", () => {
    const input = { queries: ["retrieval", "self-attention"] }
    render("mcp__anysearch__batch_search", { input, status: "pending" })
    expect(capturedTrigger).toEqual({
      icon: "orbit",
      title: "Anysearch Batch",
      subtitle: "2 parallel searches",
      tags: [{ label: "2 queries" }],
    })
    render("mcp__anysearch__batch_search", {
      input,
      output: JSON.stringify([10, 3]),
      status: "completed",
      time: { start: 1000, end: 3400 },
    })
    expect(capturedTrigger).toEqual({
      icon: "orbit",
      title: "Anysearch Batch",
      subtitle: "2 parallel searches",
      tags: [{ label: "2 queries" }],
    })
  })

  test("anysearch extract trigger shows the url and host tag", () => {
    render("mcp__anysearch__extract", {
      input: { url: "https://arxiv.org/abs/2401.12345", format: "markdown" },
      status: "completed",
      output: "# paper",
    })
    expect(capturedTrigger).toEqual({
      icon: "orbit",
      title: "Anysearch Extract",
      subtitle: "https://arxiv.org/abs/2401.12345",
      tags: [{ label: "arxiv.org" }, { label: "markdown" }],
    })
  })

  test("scholight search_papers trigger carries the query and search tags", () => {
    render("mcp__scholight__search_papers", {
      input: { query: "retrieval augmented generation", strength: "standard", categories: ["cs.CL"] },
      status: "completed",
      output: JSON.stringify([{ title: "Retrieval-Augmented Generation", year: 2020 }]),
    })
    expect(capturedTrigger).toEqual({
      icon: "graduation-cap",
      title: "Scholight",
      subtitle: "retrieval augmented generation",
      tags: [{ label: "standard" }, { label: "cs.CL" }],
    })
  })

  test("scholight extract_url trigger shows the target host", () => {
    render("mcp__scholight__extract_url", {
      input: { url: "https://arxiv.org/abs/2303.08774" },
      status: "completed",
      output: "abstract text",
    })
    expect(capturedTrigger).toEqual({
      icon: "file-text",
      title: "Scholight Extract",
      subtitle: "https://arxiv.org/abs/2303.08774",
      tags: [{ label: "arxiv.org" }],
    })
  })

  test("renderers accept pending parts without throwing", () => {
    for (const name of registrations.keys()) {
      expect(() => registrations.get(name)!({ tool: name, input: {}, metadata: {}, status: "pending" })).not.toThrow()
    }
  })
})
