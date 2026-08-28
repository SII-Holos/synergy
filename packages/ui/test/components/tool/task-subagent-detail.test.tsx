import { describe, expect, mock, test } from "bun:test"

type TestNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

let navigateCalls: string[] = []
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
    if (typeof type === "function") {
      return (type as (p: Record<string, unknown>) => unknown)({ ...(props ?? {}), children })
    }
    return { type, props: props ?? {}, children }
  },
}

mock.module("@lingui/solid", () => ({
  useLingui: () => ({ _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id }),
}))
mock.module("solid-js", () => ({
  createMemo:
    <T,>(compute: () => T) =>
    () =>
      compute(),
  Show: (props: { when: unknown; children: unknown; fallback?: unknown }) => {
    const children = props.children
    const callback = Array.isArray(children) ? children.find((entry) => typeof entry === "function") : children
    if (props.when) {
      if (typeof callback === "function") return (callback as (accessor: () => unknown) => unknown)(() => props.when)
      return children
    }
    if (typeof props.fallback === "function") return (props.fallback as () => unknown)()
    return props.fallback ?? null
  },
  For: (props: { each: unknown[]; children: unknown }) => {
    const children = props.children
    const callback = Array.isArray(children) ? children.find((entry) => typeof entry === "function") : children
    if (typeof callback !== "function") return children
    const render = callback as (item: never, index: number) => unknown
    return (props.each ?? []).map((item, index) => render(item as never, index))
  },
}))
mock.module("../../../src/context", () => ({
  useData: () => ({
    navigateToSession: (id: string) => navigateCalls.push(id),
  }),
}))
mock.module("../../../src/components/icon", () => ({ Icon: () => null }))
mock.module("../../../src/components/spinner", () => ({ Spinner: () => null }))
mock.module("../../../src/components/semantic-icon", () => ({ getSemanticIcon: () => "open" }))
mock.module("../../../src/components/message-part", () => ({
  getToolInfo: (tool: string) => ({ icon: "terminal", title: tool }),
}))

const { TaskSubagentDetail } = await import("../../../src/components/tool/task-subagent-detail")

function collect(node: unknown, out: TestNode[] = []): TestNode[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node && typeof node === "object" && "type" in (node as object)) {
    const current = node as TestNode
    out.push(current)
    collect(current.children, out)
  }
  return out
}

function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("")
  if (node && typeof node === "object" && "type" in (node as object)) return text((node as TestNode).children)
  return typeof node === "string" ? node : ""
}

describe("TaskSubagentDetail", () => {
  test("renders identity, live state, steps, and navigates to the child session", () => {
    navigateCalls = []
    const tree = TaskSubagentDetail({
      info: {
        agentType: "explore",
        description: "Map the export surface",
        background: true,
        sessionId: "child-1",
        running: true,
        summary: [
          { id: "c1", tool: "bash", state: { status: "completed", title: "Ran tests" } },
          { id: "c2", tool: "read", state: { status: "running" } },
        ],
      },
    })

    const nodes = collect(tree)
    const slot = (name: string) => nodes.find((node) => node.props["data-slot"] === name)
    const items = nodes.filter((node) => node.props["data-slot"] === "task-tool-item")

    expect(text(slot("task-subagent-agent"))).toBe("explore")
    expect(text(slot("task-subagent-mode"))).toBe("background")
    expect(text(slot("task-subagent-state"))).toContain("Running")
    expect(slot("task-subagent-state-dot")).toBeDefined()
    expect(text(slot("task-subagent-description"))).toBe("Map the export surface")
    expect(items).toHaveLength(2)
    expect(items[0]?.props["data-state"]).toBe("completed")
    expect(text(items[0])).toContain("Ran tests")
    expect(items[1]?.props["data-state"]).toBe("running")

    const open = slot("task-subagent-open")
    expect(open?.props["type"]).toBe("button")
    ;(open?.props["onClick"] as () => void)()
    expect(navigateCalls).toEqual(["child-1"])
  })

  test("leads with the error when the delegation failed", () => {
    const tree = TaskSubagentDetail({
      info: { background: false, summary: [], running: false, error: "Agent type missing" },
    })

    const nodes = collect(tree)
    expect(text(nodes.find((node) => node.props["data-slot"] === "task-subagent-error"))).toBe("Agent type missing")
    expect(nodes.find((node) => node.props["data-slot"] === "task-subagent-state")).toBeUndefined()
    expect(nodes.find((node) => node.props["data-slot"] === "task-subagent-empty")).toBeUndefined()
    expect(nodes.find((node) => node.props["data-slot"] === "task-subagent-open")).toBeUndefined()
  })

  test("states plainly when a finished delegation recorded no steps", () => {
    const tree = TaskSubagentDetail({ info: { background: false, summary: undefined, running: false } })

    const nodes = collect(tree)
    expect(text(nodes.find((node) => node.props["data-slot"] === "task-subagent-empty"))).toBe("No steps recorded")
  })
})
