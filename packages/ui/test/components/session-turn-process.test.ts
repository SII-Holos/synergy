import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import type { ActivityGroupItem, ActivityTimelineItem } from "../../src/components/session-turn-activity"
import { projectActivityBatches, resolveActivityDisclosure } from "../../src/components/session-turn-process"

const message = { id: "assistant", path: { root: "/project" } } as AssistantMessage
function group(id: string, family: ActivityGroupItem["family"], scopeKey = "path:/project"): ActivityGroupItem {
  const part = {
    id,
    messageID: message.id,
    sessionID: "session",
    type: "tool",
    tool: family === "execute" ? "bash" : "read",
    state: { status: "completed", input: {} },
  } as ToolPart
  return {
    kind: "activity-group",
    key: id,
    message,
    family,
    scopeKey,
    state: "done",
    receipt: false,
    steps: [{ part, family, scopeKey, state: "done", icon: "terminal", title: id }],
  }
}

describe("turn process projection", () => {
  test("mixed inspections keep file identities and search operations distinct", () => {
    const read = group("read", "inspect-local")
    read.steps[0].part.activityEvidence = {
      kind: "file-read",
      resource: { path: "/project/a.ts", workspaceID: "project", generation: 1 },
    }
    const search = group("search", "inspect-local")
    search.steps[0].part.tool = "grep"
    const batch = projectActivityBatches([read, search])[0]
    if (batch.kind !== "activity-batch") throw new Error("expected batch")
    expect(batch.fileReads).toBe(1)
    expect(batch.searchOperations).toBe(1)
    expect(batch.inspectionOperations).toBe(0)
  })
  test("consecutive mixed tools share one stable batch without changing their order", () => {
    const first = group("read", "inspect-local")
    const second = group("command", "execute", "")
    const batch = projectActivityBatches([first, second])[0]
    expect(batch.kind).toBe("activity-batch")
    if (batch.kind !== "activity-batch") throw new Error("expected batch")
    expect(batch.steps.map((step) => step.part.id)).toEqual(["read", "command"])
    const initial = projectActivityBatches([first])[0]
    expect(initial.kind === "activity-batch" && initial.key).toBe(batch.key)
    expect(batch.facts).toEqual([
      { family: "inspect-local", count: 1 },
      { family: "execute", count: 1 },
    ])
  })
  test("text, scopes and receipts separate batches while adjacent messages preserve continuity", () => {
    const text: ActivityTimelineItem = { kind: "activity-boundary", key: "text", message }
    expect(projectActivityBatches([group("a", "inspect-local"), text, group("b", "execute")])).toHaveLength(3)
    expect(
      projectActivityBatches([group("a", "inspect-local", "scope:a"), group("b", "execute", "scope:b")]),
    ).toHaveLength(2)
    const foreign = { ...group("b", "execute"), message: { ...message, id: "other" } }
    expect(projectActivityBatches([group("a", "inspect-local"), foreign])).toHaveLength(1)
    const receipt = { ...group("receipt", "execute"), receipt: true }
    expect(projectActivityBatches([group("a", "inspect-local"), receipt])).toHaveLength(2)
  })
  test("approval stays actionable and past errors do not replace running state", () => {
    const failed = group("failed", "inspect-local")
    failed.steps[0].state = "error"
    const running = group("running", "execute", "")
    running.steps[0].state = "running"
    const batch = projectActivityBatches([failed, running])[0]
    if (batch.kind !== "activity-batch") throw new Error("expected batch")
    expect(batch.state).toBe("running")
    expect(batch.failures).toBe(1)
    const approval = { ...running, steps: [{ ...running.steps[0], state: "waiting-approval" as const }] }
    expect(projectActivityBatches([failed, approval])).toHaveLength(2)
  })
  test("file statistics count known successful paths without claiming failed reads", () => {
    const first = group("first", "inspect-local")
    const repeated = group("repeat", "inspect-local")
    const failed = group("missing", "inspect-local")
    first.steps[0].part.state.input = { filePath: "/project/a.ts" }
    repeated.steps[0].part.state.input = { filePath: "/project/a.ts" }
    first.steps[0].part.activityEvidence = repeated.steps[0].part.activityEvidence = {
      kind: "file-read",
      resource: { path: "/project/a.ts", workspaceID: "project", generation: 1 },
    }
    failed.steps[0].part.state.input = { filePath: "/project/missing.ts" }
    failed.steps[0].state = "error"
    const batch = projectActivityBatches([first, repeated, failed])[0]
    if (batch.kind !== "activity-batch") throw new Error("expected batch")
    expect(batch.fileReads).toBe(1)
    expect(batch.facts).toEqual([{ family: "inspect-local", count: 2 }])
    expect(batch.failures).toBe(1)
  })
  test("twenty calls across messages share stable identity and unknown file identities count operations", () => {
    const groups = Array.from({ length: 20 }, (_, i) => ({
      ...group(`read-${i}`, "inspect-local"),
      message: { ...message, id: `message-${i}` },
    }))
    const projected = projectActivityBatches(groups)
    expect(projected).toHaveLength(1)
    const batch = projected[0]
    if (batch.kind !== "activity-batch") throw new Error("expected batch")
    expect(batch.steps.map((step) => step.part.id)).toEqual(groups.map((group) => group.steps[0].part.id))
    expect(batch.fileReads).toBeUndefined()
    expect(batch.fileReadOperations).toBe(20)
    expect(projectActivityBatches(groups)[0]).toBe(batch)
  })
  test("rendering budgets do not create artificial phases in a continuous tool sequence", () => {
    const groups = Array.from({ length: 60 }, (_, i) => ({
      ...group(`command-${i}`, "execute"),
      message: { ...message, id: `message-${i}` },
    }))
    const projected = projectActivityBatches(groups)
    expect(projected).toHaveLength(1)
    const batch = projected[0]
    if (batch.kind !== "activity-batch") throw new Error("expected batch")
    expect(batch.steps.map((step) => step.part.id)).toEqual(groups.map((group) => group.steps[0].part.id))
    expect(batch.facts).toEqual([{ family: "execute", count: 60 }])
    const initial = projectActivityBatches(groups.slice(0, 20))[0]
    expect(initial.kind === "activity-batch" && initial.key).toBe(batch.key)
  })
  test("display modes share disclosure with explicit choice and reading protection", () => {
    expect(resolveActivityDisclosure({ mode: "balanced", working: true, heldOpen: false })).toBe(true)
    expect(resolveActivityDisclosure({ mode: "balanced", working: false, heldOpen: false })).toBe(false)
    expect(resolveActivityDisclosure({ mode: "balanced", working: false, heldOpen: true })).toBe(true)
    expect(resolveActivityDisclosure({ mode: "full", working: false, heldOpen: false })).toBe(true)
    expect(resolveActivityDisclosure({ mode: "minimal", working: true, heldOpen: false })).toBe(false)
    expect(resolveActivityDisclosure({ mode: "full", working: true, heldOpen: false, explicit: false })).toBe(false)
  })
})
