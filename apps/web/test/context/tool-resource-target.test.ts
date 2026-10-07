import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { supportsToolResource, toolResourceTarget } from "../../src/context/tool-resource-target"

function completed(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): ToolPart {
  return {
    id: "part",
    messageID: "message",
    sessionID: "session",
    callID: "call",
    type: "tool",
    tool,
    state: { status: "completed", input, metadata, title: tool, output: "receipt", time: { start: 1, end: 2 } },
  }
}

describe("tool resource targets", () => {
  test("Notes mutations retain the recorded note and Scope", () => {
    for (const tool of ["note_write", "note_edit"]) {
      expect(supportsToolResource(tool)).toBe(true)
      expect(toolResourceTarget(completed(tool, {}, { id: "note", scopeID: "home" }))).toEqual({
        panelId: "notes",
        resourceId: "note",
        source: "home",
      })
      expect(toolResourceTarget(completed(tool, {}, { id: "" }))).toBeUndefined()
    }
  })

  test("a Note read opens only one evidenced requested note", () => {
    expect(toolResourceTarget(completed("note_read", { noteIds: ["note"] }, { count: 1 }))).toEqual({
      panelId: "notes",
      resourceId: "note",
    })
    for (const input of [{}, { noteIds: [] }, { noteIds: ["note", "other"] }, { noteIds: [4] }]) {
      expect(toolResourceTarget(completed("note_read", input, { count: 1 }))).toBeUndefined()
    }
    expect(toolResourceTarget(completed("note_read", { noteIds: ["note"] }, { count: 2 }))).toBeUndefined()
  })

  test("Browser results require recorded page identity and exclude list and close", () => {
    expect(supportsToolResource("browser_read")).toBe(true)
    expect(
      toolResourceTarget(completed("browser_read", { pageId: "input-page" }, { pageId: "recorded-page" })),
    ).toEqual({
      panelId: "browser",
      resourceId: "recorded-page",
    })
    expect(toolResourceTarget(completed("browser_read", { pageId: "input-page" }))).toBeUndefined()
    for (const action of ["list", "close"]) {
      expect(toolResourceTarget(completed("browser_navigation", { action }, { pageId: "page" }))).toBeUndefined()
    }
    expect(toolResourceTarget(completed("browser_navigation", { action: "navigate" }, { pageId: "page" }))).toEqual({
      panelId: "browser",
      resourceId: "page",
    })
  })

  test("failed, active and unsuccessful business receipts retain execution details", () => {
    const part = completed("note_write", {}, { id: "note" })
    expect(toolResourceTarget({ ...part, state: { status: "pending", input: {}, raw: "" } })).toBeUndefined()
    expect(
      toolResourceTarget({
        ...part,
        state: { status: "error", input: {}, error: "failed", time: { start: 1, end: 2 } },
      }),
    ).toBeUndefined()
    for (const flag of ["blocked", "conflict", "errorCode", "dryRun"]) {
      expect(toolResourceTarget(completed("note_write", {}, { id: "note", [flag]: true }))).toBeUndefined()
    }
    expect(supportsToolResource("bash")).toBe(false)
    expect(toolResourceTarget(completed("bash", {}, { id: "note", pageId: "page" }))).toBeUndefined()
  })
})
