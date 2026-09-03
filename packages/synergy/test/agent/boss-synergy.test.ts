import { describe, expect, test } from "bun:test"
import { createBuiltinPrimaryAgents } from "../../src/agent/builtin-primary"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

function action(agent: ReturnType<typeof createBuiltinPrimaryAgents>[string], permission: string) {
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

describe("boss-synergy primary agent", () => {
  const agents = createBuiltinPrimaryAgents(ctx)

  test("is a hidden native primary agent with a coordination prompt", () => {
    const agent = agents["boss-synergy"]
    expect(agent).toBeDefined()
    expect(agent.mode).toBe("primary")
    expect(agent.native).toBe(true)
    expect(agent.hidden).toBe(true)
    expect(agent.prompt).toContain("协调者")
  })

  test("allows the coordination whitelist (sessions, agenda, memory, notes)", () => {
    const agent = agents["boss-synergy"]
    for (const permission of [
      "boss_spawn",
      "boss_assign",
      "boss_status",
      "boss_cancel",
      "boss_project",
      "channel_push",
      "session_control",
      "session_send",
      "session_read",
      "session_list",
      "session_search",
      "scope_list",
      "agenda_list",
      "agenda_schedule",
      "agenda_update",
      "agenda_cancel",
      "agenda_trigger",
      "agenda_watch",
      "agenda_logs",
      "memory_get",
      "memory_write",
      "memory_edit",
      "memory_search",
      "note_list",
      "note_read",
      "note_search",
      "note_write",
      "note_edit",
      "question",
      "bash",
      "process",
    ]) {
      expect(action(agent, permission), permission).toBe("allow")
    }
  })

  test("denies subagent, file, runtime, destructive-note, and agenda-internal tools", () => {
    const agent = agents["boss-synergy"]
    for (const permission of [
      "task",
      "task_list",
      "task_output",
      "task_cancel",
      "view_file",
      "revise_file",
      "save_file",
      "scan_files",
      "parse_code",
      "read",
      "edit",
      "write",
      "grep",
      "ast_grep",
      "runtime_reload",
      "dagwrite",
      "dagread",
      "dagpatch",
      "note_archive",
      "note_delete",
    ]) {
      expect(action(agent, permission), permission).toBe("deny")
    }
  })

  test("denies unknown tools via the wildcard deny", () => {
    const agent = agents["boss-synergy"]
    expect(action(agent, "websearch")).toBe("deny")
    expect(action(agent, "todowrite")).toBe("deny")
  })
})

test("boss-synergy registers through the agent registry", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const agent = await Agent.get("boss-synergy")
      expect(agent).toBeDefined()
      expect(agent?.mode).toBe("primary")
      expect(agent?.native).toBe(true)
      expect(agent?.prompt).toContain("协调者")
      expect(PermissionNext.evaluate("boss_spawn", "*", agent!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("bash", "*", agent!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("task", "*", agent!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("view_file", "*", agent!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("runtime_reload", "*", agent!.permission).action).toBe("deny")
    },
  })
})
