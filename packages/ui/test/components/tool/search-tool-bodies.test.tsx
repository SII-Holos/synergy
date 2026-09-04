import { beforeEach, describe, expect, mock, test } from "bun:test"

const registrations = new Map<string, (props: Record<string, any>) => unknown>()
let capturedSummaryRows: Array<{ label: string; value?: unknown } | undefined> | undefined
let capturedResultRows: Array<{ title: string; meta?: string }> | undefined
let capturedRaw: string | undefined
let capturedEach: unknown[] | undefined
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
  Fragment: (props: { children?: unknown }) => props.children ?? null,
  Show: (props: any) => {
    // Eager shim: function children receive the value through an accessor,
    // mirroring real Solid `<Show>{() => …}</Show>` semantics so branch
    // bodies execute for assertions.
    const when = props.when
    const truthy = when !== undefined && when !== null && when !== false
    if (truthy) {
      const child = Array.isArray(props.children) ? props.children[0] : props.children
      return typeof child === "function" ? child(() => when) : (child ?? null)
    }
    return props.fallback ?? null
  },
  For: (props: { each: unknown }) => {
    capturedEach = Array.isArray(props.each) ? (props.each as unknown[]) : undefined
    return null
  },
}))
mock.module("../../../src/components/message-part", () => ({
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
      registrations.set(entry.name, entry.render)
    },
  },
}))
mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: () => null,
}))
mock.module("../../../src/components/spinner", () => ({ Spinner: () => null }))
mock.module("../../../src/components/tool/renders/search-result-parts", () => ({
  SearchSummary: (props: { rows: Array<{ label: string; value?: unknown } | undefined> }) => {
    capturedSummaryRows = props.rows
    return null
  },
  SearchResultRows: (props: { rows: Array<{ title: string; meta?: string }> }) => {
    capturedResultRows = props.rows
    return null
  },
  RawToolOutput: (props: { output?: string }) => {
    capturedRaw = props.output
    return null
  },
}))

await import("../../../src/components/tool/renders/anysearch")
await import("../../../src/components/tool/renders/scholight")

function render(name: string, props: Record<string, any>) {
  capturedSummaryRows = undefined
  capturedResultRows = undefined
  capturedRaw = undefined
  capturedEach = undefined
  registrations.get(name)?.({
    tool: name,
    input: {},
    metadata: {},
    ...props,
  })
}

const PAPERS_OUTPUT = JSON.stringify([
  { title: "Attention Is All You Need", year: "2017", venue: "NeurIPS" },
  { title: "BERT", year: "2018", venue: "NAACL" },
  { title: "GPT-3", year: "2020" },
])

beforeEach(() => {
  capturedSummaryRows = undefined
  capturedResultRows = undefined
  capturedRaw = undefined
  capturedEach = undefined
})

describe("remote MCP search card bodies by state", () => {
  test("anysearch search completed with parseable output shows summary strip and top rows", () => {
    render("mcp__anysearch__search", {
      input: { query: "attention", domains: ["arxiv.org"] },
      output: PAPERS_OUTPUT,
      status: "completed",
      time: { start: 1000, end: 2400 },
    })
    expect(capturedSummaryRows?.find((row) => row?.label === "Domains")?.value).toBe("arxiv.org")
    expect(capturedSummaryRows?.find((row) => row?.label === "Results")?.value).toBe("3 results")
    expect(capturedSummaryRows?.find((row) => row?.label === "Elapsed")?.value).toBe("1.4s")
    expect(capturedResultRows?.length).toBe(3)
  })

  test("anysearch search completed with plain-text output falls back to the raw body", () => {
    render("mcp__anysearch__search", {
      input: { query: "attention" },
      output: "no structured results returned",
      status: "completed",
    })
    expect(capturedResultRows).toBeUndefined()
    expect(capturedSummaryRows?.some((row) => row?.label === "Results")).toBe(false)
    expect(capturedRaw).toBe("no structured results returned")
  })

  test("anysearch search pending renders no result rows", () => {
    render("mcp__anysearch__search", { input: { query: "attention" }, status: "pending" })
    expect(capturedResultRows).toBeUndefined()
  })

  test("anysearch batch_search completed with countable output renders per-query rows", () => {
    render("mcp__anysearch__batch_search", {
      input: { queries: ["retrieval", "self-attention", "rag"] },
      output: JSON.stringify([10, 3, 7]),
      status: "completed",
      time: { start: 1000, end: 3400 },
    })
    // The eager-shim harness constructs fallback elements eagerly, so the
    // raw-output capture is not a reliable negative signal here; the
    // per-query row capture proves the countable branch renders.
    expect(capturedEach).toEqual([
      { query: "retrieval", count: 10 },
      { query: "self-attention", count: 3 },
      { query: "rag", count: 7 },
    ])
  })

  test("anysearch batch_search pending lists the queries with no counts", () => {
    render("mcp__anysearch__batch_search", {
      input: { queries: ["retrieval", "self-attention"] },
      status: "pending",
    })
    expect(capturedEach).toEqual(["retrieval", "self-attention"])
    expect(capturedRaw).toBeUndefined()
  })

  test("anysearch batch_search completed with unparseable output falls back to the raw body", () => {
    render("mcp__anysearch__batch_search", {
      input: { queries: ["retrieval"] },
      output: "finished with 8 results",
      status: "completed",
    })
    expect(capturedRaw).toBe("finished with 8 results")
  })

  test("anysearch extract keeps the raw body and host strip", () => {
    render("mcp__anysearch__extract", {
      input: { url: "https://arxiv.org/abs/2401.12345" },
      output: "# full text",
      status: "completed",
    })
    expect(capturedSummaryRows?.find((row) => row?.label === "Host")?.value).toBe("arxiv.org")
    expect(capturedRaw).toBe("# full text")
  })

  test("scholight search_papers completed with parseable output shows paper count and rows", () => {
    render("mcp__scholight__search_papers", {
      input: { query: "attention", strength: "standard" },
      output: PAPERS_OUTPUT,
      status: "completed",
      time: { start: 1000, end: 2400 },
    })
    expect(capturedSummaryRows?.find((row) => row?.label === "Papers")?.value).toBe("3 papers")
    expect(capturedSummaryRows?.find((row) => row?.label === "Strength")?.value).toBe("standard")
    expect(capturedResultRows?.[0]).toEqual({ title: "Attention Is All You Need", meta: "2017 · NeurIPS" })
    expect(capturedResultRows?.length).toBe(3)
  })

  test("scholight search_papers completed with plain-text output falls back to the raw body", () => {
    render("mcp__scholight__search_papers", {
      input: { query: "attention" },
      output: "no papers matched",
      status: "completed",
    })
    expect(capturedResultRows).toBeUndefined()
    expect(capturedRaw).toBe("no papers matched")
  })

  test("scholight extract_url keeps the raw body with a host strip", () => {
    render("mcp__scholight__extract_url", {
      input: { url: "https://arxiv.org/abs/2303.08774" },
      output: "abstract text",
      status: "completed",
      time: { start: 0, end: 500 },
    })
    expect(capturedSummaryRows?.find((row) => row?.label === "Host")?.value).toBe("arxiv.org")
    expect(capturedSummaryRows?.find((row) => row?.label === "Elapsed")?.value).toBe("500ms")
    expect(capturedRaw).toBe("abstract text")
  })
})
