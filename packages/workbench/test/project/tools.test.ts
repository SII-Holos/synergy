import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerProjectTools } from "../../src/project/tools"

test("the project provider registers archive once in the deferred worktree group", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({ workers: false, environment: false })
        registerProjectTools()
        registerProjectTools()
      },
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        expect(ToolRegistry.toolProviderIDs()).toContain("project")
        expect((await ToolRegistry.ids()).filter((id) => id === "worktree_archive")).toEqual(["worktree_archive"])
        const archiveTool = (await ToolRegistry.tools("openai")).find((tool) => tool.id === "worktree_archive")
        expect(archiveTool).toBeDefined()
        expect(archiveTool?.exposure).toEqual({ mode: "group", group: "worktree" })
        expect(ToolExposure.builtinGroup("worktree")?.tools).toContain("worktree_archive")
        expect(ToolExposure.isVisible("worktree_archive", archiveTool?.exposure, {})).toBe(false)
        expect(
          ToolExposure.isVisible("worktree_archive", archiveTool?.exposure, { expandedGroups: ["worktree"] }),
        ).toBe(true)
      },
    }),
  )
})

test("a runtime without the project provider does not discover archive", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        expect(ToolRegistry.toolProviderIDs()).not.toContain("project")
        expect(await ToolRegistry.ids()).not.toContain("worktree_archive")
      },
    }),
  )
})
