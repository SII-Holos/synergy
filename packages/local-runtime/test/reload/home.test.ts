import { expect, spyOn, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { RuntimeReload } from "../../src/reload"
import { testRuntime } from "../support/runtime"

test("Home file watching classifies global domains without requiring a workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const file = ConfigDomain.filepath("models")
        expect(RuntimeReload.detectScopeForFile(file)).toBe("global")
        expect(RuntimeReload.detectTargetsForFile(file)).toContain("config")
        expect(
          RuntimeReload.detectScopeForFile("/unrelated/project/.synergy/synergy.d/10-models.jsonc"),
        ).toBeUndefined()
        expect(
          RuntimeReload.builtinSourceEditWarning("/unrelated/project/packages/harness/src/index.ts"),
        ).toBeUndefined()
      },
    }),
  )
})

test("provider refresh works in Home without a workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const result = await RuntimeReload.reload({ targets: ["provider"] })
        expect(result.success).toBe(true)
        expect(result.executed).toEqual(["config", "provider", "agent"])
        expect((await RuntimeReload.reloadGlobal({ targets: ["provider"] })).success).toBe(true)
      },
    }),
  )
})

test("concurrent targets share a failed prerequisite without retrying or executing dependents", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        using reload = spyOn(Config, "reload").mockRejectedValue(new Error("config unavailable"))
        const result = await RuntimeReload.reload({ targets: ["provider", "agent"] })
        expect(reload).toHaveBeenCalledTimes(1)
        expect(result.success).toBe(false)
        expect(result.executed).toEqual([])
        expect(result.failed).toContain("provider")
        expect(result.failed).toContain("agent")
        expect(result.failures.filter((failure) => failure.code?.endsWith("reload_blocked"))).toHaveLength(2)
      },
    }),
  )
})
