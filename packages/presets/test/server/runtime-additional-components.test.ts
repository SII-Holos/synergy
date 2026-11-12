import { expect, test } from "bun:test"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { acceptanceOrigins } from "../../script/acceptance/origin"

for (const mode of ["task", "http"] as const)
  test(`${mode} embedding composes an additional native owner before registration seals`, async () => {
    await using fixture = await runtimeHome()
    const origins = acceptanceOrigins()
    expect(() => origins.capture("before-composition")).toThrow("composed")
    let allocations = 0
    const failure = new Error("Original provider response lost")
    const component: RuntimeComponent = {
      id: "preset-extra-origin",
      version: "1.0.0",
      apiVersion: 1,
      register() {
        EnvironmentProviders.register({
          id: "preset-extra-origin",
          async allocate() {
            allocations++
            throw failure
          },
          async inspect() {
            return { state: "unknown" }
          },
          async deallocate() {},
        })
      },
    }
    const options = {
      host: fixture.host,
      mode: "oneshot" as const,
      additionalComponents: [component, origins.component],
      network: { hostname: "127.0.0.1", port: 0 },
    }
    await using runtime = await (mode === "task"
      ? PresetRuntimeHandle.openTask(options)
      : PresetRuntimeHandle.open(options))
    expect(runtime.components.some((selected) => selected.id === component.id)).toBeTrue()
    await runtime.run(async () => {
      expect(() => EnvironmentOrigin.registerHost("late-origin")).toThrow("before opening")
      const environment = await Environment.bind({
        scopeID: "home",
        ownerID: "acceptance",
        provider: "preset-extra-origin",
        spec: {},
      })
      await expect(
        Environment.acquire(environment.id, {
          scopeID: "home",
          useID: "acceptance",
          capabilities: ["exec"],
          ownership: origins.capture("fault-allocation-ack"),
        }),
      ).rejects.toBe(failure)
      expect(allocations).toBe(1)
      expect((await Environment.get(environment.id, "home")).state).toBe("allocating")
    })
  }, 30_000)
