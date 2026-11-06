import { describe, expect, test } from "bun:test"
import {
  compactTasks,
  compactTokenText,
  cancellableTask,
  compactTaskStatus,
} from "../../../src/components/execution/task-details-model"

const task = {
  sessionID: "child",
  nodeID: null,
  parentID: "root",
  title: "Chronicler",
  status: "unknown" as const,
  elapsedMs: null,
  elapsedActive: false,
  elapsedLowerBound: false,
  tokens: { known: 0, unknown: 0, total: 0 },
  runs: [],
}

describe("compact task details", () => {
  test("only explicit auxiliary sources are omitted; legacy names and delegated reviewers remain", () => {
    const legacy = { ...task, sessionID: "legacy" }
    const background = { ...task, interaction: { mode: "unattended" as const, source: "chronicler" } }
    const vision = {
      ...background,
      sessionID: "vision",
      interaction: { ...background.interaction, source: "tool:look_at" },
    }
    const reviewer = {
      ...background,
      sessionID: "reviewer",
      cortex: { taskID: "ctx_reviewer", agent: "reviewer", status: "running" as const, visibility: "hidden" as const },
    }
    const agenda = { ...background, sessionID: "agenda", interaction: { ...background.interaction, source: "agenda" } }
    expect(compactTasks([legacy, background, vision, reviewer, agenda]).map((item) => item.sessionID)).toEqual([
      "legacy",
      "reviewer",
      "agenda",
    ])
  })

  test("cancellation uses canonical delegation state even before rollout evidence exists", () => {
    expect(cancellableTask(task)).toBe(false)
    for (const status of ["queued", "running"] as const)
      expect(cancellableTask({ ...task, cortex: { taskID: "ctx_live", agent: "forge", status } })).toBe(true)
    for (const status of ["completed", "error", "cancelled", "interrupted"] as const)
      expect(cancellableTask({ ...task, cortex: { taskID: "ctx_done", agent: "forge", status } })).toBe(false)
  })

  test("queued and terminal delegation states remain explicit without rollout timings", () => {
    expect(compactTaskStatus({ ...task, cortex: { taskID: "ctx_live", agent: "forge", status: "queued" } })).toBe(
      "queued",
    )
    expect(compactTaskStatus({ ...task, cortex: { taskID: "ctx_done", agent: "forge", status: "error" } })).toBe(
      "failed",
    )
    expect(compactTaskStatus(task)).toBe("unknown")
  })

  test("unavailable usage is omitted, measured zero is preserved and lower bounds remain honest", () => {
    expect(compactTokenText({ known: 0, unknown: 0, total: 0 }, 0, "en")).toBeUndefined()
    expect(compactTokenText({ known: 0, unknown: 0, total: 0 }, 1, "en")).toBe("0")
    expect(compactTokenText({ known: 0, unknown: 2, total: null }, 2, "en")).toBeUndefined()
    expect(compactTokenText({ known: 1200, unknown: 1, total: null }, 2, "en")).toBe("≥ 1.2K")
  })
})
