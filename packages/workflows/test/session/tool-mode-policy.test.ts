import { describe, expect, test } from "bun:test"
import { SessionModePolicy } from "../../src/session/tool-mode-policy"

const planSession = {
  workflow: { kind: "plan" },
} as any

describe("SessionModePolicy Plan visibility", () => {
  test("allows bash to stay visible in Plan", () => {
    expect(SessionModePolicy.visibility({ toolName: "bash", session: planSession })).toBeUndefined()
  })

  test("does not gate any tool by the Plan workflow", () => {
    for (const toolName of [
      "edit",
      "write",
      "save_file",
      "revise_file",
      "resolve_conflicts",
      "process",
      "attach",
      "render",
      "todowrite",
      "memory_write",
      "email_read",
      "email_send",
      "channel_push",
      "computer_apps",
      "computer_observe",
      "browser_read",
      "browser_action",
      "openai_image_gen",
      "mcp__anysearch__search",
      "mcp__scholight__search_papers",
      "agent_config",
      "connect",
    ]) {
      expect(SessionModePolicy.visibility({ toolName, session: planSession }), toolName).toBeUndefined()
    }
  })

  test("keeps shell commands ungated because Plan is guidance rather than a shell boundary", () => {
    for (const toolName of ["bash", "process"]) {
      expect(SessionModePolicy.visibility({ toolName, session: planSession }), toolName).toBeUndefined()
    }
  })
})

describe("SessionModePolicy workflow-surface guards", () => {
  test("still hides Lattice parent tools outside Lattice", () => {
    for (const toolName of ["pathway_read", "pathway_write", "lattice_submit"]) {
      expect(SessionModePolicy.visibility({ toolName, session: planSession }), toolName).toMatchObject({
        code: "tool_unavailable",
        toolName,
      })
    }
  })

  test("still hides Boss tools outside Boss Mode", () => {
    for (const toolName of ["boss_spawn", "boss_assign", "boss_report", "boss_status", "boss_cancel", "boss_project"]) {
      expect(SessionModePolicy.visibility({ toolName, session: planSession }), toolName).toMatchObject({
        code: "tool_unavailable",
        toolName,
      })
    }
  })

  test("keeps workflow-domain unavailable reasons outside Plan", () => {
    for (const reason of ["audit_only", "blueprint_loop_required", "light_loop_required"]) {
      expect(SessionModePolicy.unavailable({ toolName: "blueprint_loop_stop", reason })).toMatchObject({
        code: "tool_unavailable",
        toolName: "blueprint_loop_stop",
      })
    }
    expect(SessionModePolicy.unavailable({ toolName: "blueprint_loop_stop", reason: "audit_only" })?.message).toContain(
      "Blueprint audit session",
    )
  })

  test("leaves generic unavailable reasons to the core implementation", () => {
    for (const reason of ["permission", "user_disabled", "deferred"]) {
      expect(SessionModePolicy.unavailable({ toolName: "read", reason })).toBeUndefined()
    }
  })
})

describe("SessionModePolicy Lattice execution visibility", () => {
  test("explains that parent Lattice tools cannot be bypassed during the owned BlueprintLoop step", () => {
    const diagnostic = SessionModePolicy.visibility({
      toolName: "lattice_submit",
      session: {
        workflow: { kind: "lattice", runID: "ltr_test", mode: "auto" },
        blueprint: { loopID: "bpl_test", loopRole: "execution" },
      } as any,
    })

    expect(diagnostic).toMatchObject({
      code: "tool_unavailable",
      toolName: "lattice_submit",
      metadata: {
        submitted: false,
        owner: "blueprint_loop",
        loopID: "bpl_test",
        retryable: false,
      },
    })
    expect(diagnostic?.message).toContain("No Lattice action was submitted")
    expect(diagnostic?.message).toContain("Do not work around this boundary")
    expect(diagnostic?.message).toContain("future Pathway Step")
    expect(diagnostic?.message).toContain("blueprint_loop_stop")
    expect(diagnostic?.message).toContain("end this assistant turn immediately")
  })
})

describe("SessionModePolicy Boss visibility", () => {
  const bossSession = {
    workflow: { kind: "boss", role: "boss", rootID: "ses_boss" },
  } as any
  const workerSession = {
    workflow: { kind: "boss", role: "worker", workerRole: "code", rootID: "ses_boss" },
  } as any

  test("hides Boss tools outside Boss Mode", () => {
    for (const tool of ["boss_spawn", "boss_assign", "boss_report", "boss_status", "boss_cancel", "boss_project"]) {
      expect(SessionModePolicy.visibility({ toolName: tool, session: {} })).toMatchObject({
        code: "tool_unavailable",
        toolName: tool,
      })
    }
  })

  test("exposes boss tools to the root boss except worker-only boss_report", () => {
    expect(SessionModePolicy.visibility({ toolName: "boss_spawn", session: bossSession })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "boss_assign", session: bossSession })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "boss_status", session: bossSession })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "boss_cancel", session: bossSession })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "boss_project", session: bossSession })).toBeUndefined()
    expect(SessionModePolicy.visibility({ toolName: "boss_report", session: bossSession })).toMatchObject({
      code: "tool_unavailable",
      toolName: "boss_report",
    })
  })

  test("exposes boss tools to workers except boss_project (boss-only)", () => {
    for (const tool of ["boss_spawn", "boss_assign", "boss_report", "boss_status", "boss_cancel"]) {
      expect(SessionModePolicy.visibility({ toolName: tool, session: workerSession })).toBeUndefined()
    }
    expect(SessionModePolicy.visibility({ toolName: "boss_project", session: workerSession })).toMatchObject({
      code: "tool_unavailable",
      toolName: "boss_project",
    })
  })
})
