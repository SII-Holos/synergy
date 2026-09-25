import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { workerPlan, registerWorkerComponents } from "@ericsanchezok/synergy-agent-runtime/workers"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { fullComponents } from "../../src/components"

for (const full of [true, false])
  test(`${full ? "full" : "MCP-only"} workers register only their selected configuration and seal it`, async () => {
    await using fixture = await runtimeHome()
    const components = RuntimeComponents.resolve([
      localRuntime({ workers: false }),
      plugins(),
      ...(full ? fullComponents() : [mcp()]),
    ])
    const context = RuntimeContext.create({
      ...fixture.host,
      env: { ...fixture.host.env, SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(components)) },
    })
    try {
      await context.run(async () => {
        await registerWorkerComponents("agent")
        expect(Config.Info.safeParse({ mcp: { fixture: { type: "local", command: ["fixture"] } } }).success).toBe(true)
        for (const field of ["lsp", "formatter", "external_agent", "library", "boss", "voice"])
          expect(field in Config.Info.shape, field).toBe(full)
        expect(Config.Info.safeParse({ mcp: { fixture: { type: "invalid" } } }).success).toBe(false)
        expect(() => ConfigExtensions.register("late", { shape: {} })).toThrow("before opening")
      })
    } finally {
      context.dispose()
    }
  })
