import { describe, expect, test } from "bun:test"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

function withRole(role: "boss" | "seat" | "contractor" | undefined) {
  return role ? { workflowRun: { runID: "wfr_1", role } } : {}
}

describe("workflow tool visibility", () => {
  test("boss tools are hidden outside a boss session", () => {
    for (const tool of ["workflow_run_control", "workflow_entity_add", "workflow_gate_resolve"]) {
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
})
