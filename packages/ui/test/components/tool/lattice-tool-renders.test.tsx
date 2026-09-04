import { describe, expect, mock, test } from "bun:test"

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
    _: (descriptor: { message?: string; id: string; values?: { count?: number } }) =>
      (descriptor.message ?? descriptor.id).replace("{count}", String(descriptor.values?.count ?? "{count}")),
  }),
}))
mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: { trigger: Record<string, unknown> }) => {
    capturedTrigger = props.trigger
    return null
  },
}))
mock.module("../../../src/components/message-part", () => ({
  browserToolLabels: {},
  ToolRegistry: {
    register: (entry: { name: string; render: (props: Record<string, any>) => unknown }) => {
      registrations.set(entry.name, entry.render)
    },
  },
}))

for (const name of ["file-ops", "standard", "task", "dag", "browser", "anysearch", "scholight", "batch"]) {
  mock.module(`../../../src/components/tool/renders/${name}`, () => ({}))
}

await import("../../../src/components/tool-renders")

describe("Lattice tool renderers", () => {
  test("registers the complete v2 tool surface and no legacy patch renderer", () => {
    expect([...registrations.keys()].toSorted()).toEqual([
      "boss_assign",
      "boss_cancel",
      "boss_project",
      "boss_report",
      "boss_spawn",
      "boss_status",
      "channel_push",
      "lattice_submit",
      "pathway_read",
      "pathway_write",
    ])
    expect(registrations.has("pathway_patch")).toBe(false)
  })

  test("renders boss_project with the crown glyph and directory subtitle", () => {
    registrations.get("boss_project")?.({
      tool: "boss_project",
      input: { directory: "/work/projects/alpha", title: "Alpha" },
      metadata: {},
    })
    expect(capturedTrigger).toEqual({
      icon: "crown",
      title: { id: "tool.title.boss-project", message: "Create project" },
      subtitle: "/work/projects/alpha",
      tags: undefined,
    })
  })

  test("renders channel_push with the crown glyph and text subtitle", () => {
    registrations.get("channel_push")?.({
      tool: "channel_push",
      input: { text: "Done: task complete", chatId: "oc_test_group" },
      metadata: {},
    })
    expect(capturedTrigger).toEqual({
      icon: "crown",
      title: { id: "tool.title.channel-push", message: "Push to channel" },
      subtitle: "Done: task complete",
      tags: undefined,
    })
  })

  test("registers boss tool renderers with the crown glyph", () => {
    registrations.get("boss_status")?.({
      tool: "boss_status",
      input: {},
      metadata: { workerCount: 3 },
    })
    expect(capturedTrigger).toEqual({
      icon: "crown",
      title: { id: "tool.title.boss-status", message: "View worker tree" },
      subtitle: "",
      tags: [{ label: "3" }],
    })
  })

  test("renders semantic approval copy and localized source metadata", () => {
    registrations.get("lattice_submit")?.({
      tool: "lattice_submit",
      input: { action: "approve_execution", reason: "Reviewed" },
      metadata: { source: "panel" },
    })

    expect(capturedTrigger).toEqual({
      icon: "circle-check",
      title: { id: "tool.title.latticeApproveExecution", message: "Approve Blueprint execution" },
      subtitle: "Reviewed",
      tags: [{ label: "Panel" }],
    })
  })

  test("summarizes only the future Steps accepted by pathway_write", () => {
    registrations.get("pathway_write")?.({
      tool: "pathway_write",
      input: { futureSteps: [{ title: "Build" }, { title: "Verify" }] },
      metadata: { preservedStepCount: 3, editableFutureCount: 2 },
    })

    expect(capturedTrigger).toEqual({
      icon: "list-checks",
      title: { id: "tool.title.pathwayWrite", message: "Write Pathway" },
      subtitle: undefined,
      tags: [{ label: "2 steps" }],
    })
  })
})
