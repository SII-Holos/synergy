import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "../src/component"

test("the declared worker registers local settings and SDKs only when selected", async () => {
  await using fixture = await runtimeHome()
  const context = RuntimeContext.create(fixture.host)
  try {
    await context.run(async () => {
      const component = localRuntime({ workers: false, environment: false })
      expect(() => ProviderSdkSource.loadSync("@ai-sdk/openai-compatible")).toThrow("not registered")
      const worker: typeof import("../src/worker") = await import(component.workers!.agent!.href)
      expect(worker.metadata).toEqual({ id: "local-runtime", apiVersion: 1, version: component.version })
      worker.registerWorker()
      expect(typeof ProviderSdkSource.loadSync("@ai-sdk/openai-compatible")).toBe("function")
      expect(Config.Info.safeParse({ skills: {} }).success).toBe(true)
      expect(Config.Info.safeParse({ skills: "invalid" }).success).toBe(false)
    })
  } finally {
    context.dispose()
  }
})

test("selected local composition supplies both Home reload executors", async () => {
  await using runtime = await testRuntime({
    composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false })]),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        expect(RuntimeComponents.selected().map((component) => component.id)).toEqual(["local-runtime"])
        for (const reload of [RuntimeReloadExecutor.reload, RuntimeReloadExecutor.reloadGlobal]) {
          const result = await reload({ targets: ["config"] })
          expect(result.success).toBe(true)
          expect(result.executed).toEqual(["config"])
          expect(result.warnings).not.toContain("runtime reload executor not registered")
        }
      },
    }),
  )
})
