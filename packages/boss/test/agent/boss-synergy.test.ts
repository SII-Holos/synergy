import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "../support/runtime"

test("Boss registers its hidden coordinator with the complete required-owner whitelist", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const agent = await Agent.get("boss-synergy")
        expect(agent).toMatchObject({ mode: "primary", native: true, hidden: true })
        expect(agent.prompt).toContain("协调者")
        expect(agent.prompt).toContain("不自行修改项目内容")
        expect(agent.prompt).toContain("确认结果后再报告完成")
        for (const permission of [
          "search_tools",
          "expand_tools",
          "boss_spawn",
          "boss_assign",
          "boss_status",
          "boss_cancel",
          "boss_project",
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
          "question",
          "bash",
          "process",
        ])
          expect(PermissionNext.evaluate(permission, "*", agent.permission).action, permission).toBe("allow")
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
          "note_list",
          "note_read",
          "note_search",
          "note_write",
          "note_edit",
          "note_archive",
          "note_delete",
          "channel_push",
          "webfetch",
          "todowrite",
          "unknown_future_tool",
        ])
          expect(PermissionNext.evaluate(permission, "*", agent.permission).action, permission).toBe("deny")
      },
    }),
  )
})
