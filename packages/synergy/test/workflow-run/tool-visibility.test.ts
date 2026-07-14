import { describe, expect, test } from "bun:test"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"
import type { Info as SessionInfo } from "../../src/session/types"

function withRole(role: "boss" | "seat" | undefined) {
  return role ? { workflowRun: { runID: "wfr_1", role } } : {}
}

describe("workflow tool visibility", () => {
  test("boss tools are hidden outside a boss session", () => {
    for (const tool of [
      "workflow_run_control",
      "workflow_entity_add",
      "workflow_gate_resolve",
      "workflow_entity_unblock",
    ]) {
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("seat") })).toBeDefined()
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole(undefined) })).toBeDefined()
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("boss") })).toBeUndefined()
    }
  })

  test("seat tools are hidden outside a seat session", () => {
    for (const tool of ["workflow_submit", "workflow_block"]) {
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("boss") })).toBeDefined()
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole(undefined) })).toBeDefined()
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("seat") })).toBeUndefined()
    }
  })

  test("broadly-available workflow tools are never gated by role", () => {
    for (const tool of ["workflow_run_create", "workflow_status", "workflow_charter_draft"]) {
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole(undefined) })).toBeUndefined()
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("boss") })).toBeUndefined()
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("seat") })).toBeUndefined()
    }
  })

  test("implementation tools are hidden from a boss session by taxonomy", () => {
    const bossHidden = [
      "task",
      "task_cancel",
      "task_list",
      "task_output",
      "dagwrite",
      "dagpatch",
      "revise_file",
      "save_file",
      "note_write",
      "note_edit",
      "bash",
      "edit",
      "write",
    ]
    for (const tool of bossHidden) {
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole("boss") })).toBeDefined()
      // Not a seat session = the seat role does not own these tools exclusively,
      // but the boss role must never use them.  An unbound session can still
      // see them.
      expect(SessionModePolicy.visibility({ toolName: tool, session: withRole(undefined) })).toBeUndefined()
    }
  })

  test("execution-time policy rechecks Boss restrictions", () => {
    const diagnostic = SessionModePolicy.evaluateCall({
      toolName: "edit",
      args: { filePath: "src/index.ts" },
      session: withRole("boss") as unknown as SessionInfo,
      capabilities: [],
    })
    expect(diagnostic).toBeDefined()
  })
})
