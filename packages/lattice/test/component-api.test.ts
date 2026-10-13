import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { server } from "@ericsanchezok/synergy-server/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { lattice } from "../src/component"

const components = RuntimeComponents.resolve([
  localRuntime({ workers: false, environment: false }),
  note(),
  blueprint(),
  lattice(),
])
const adapters = await Promise.all(
  components.flatMap((component) => (component.adapters?.http ? [import(component.adapters.http.href)] : [])),
)
for (const selected of [false, true]) {
  test(`lattice HTTP capability follows explicit composition after its adapters were imported (${selected})`, async () => {
    const composition = RuntimeComponents.compose([
      ...(selected ? components : [localRuntime({ workers: false, environment: false })]),
      server(),
    ])
    await using runtime = await testRuntime({
      composition: {
        register() {
          composition.register()
          if (selected) for (const adapter of adapters) adapter.registerHttp()
        },
      },
    })
    await runtime.run(async () => {
      const response = await Server.App().request("/global/capabilities")
      expect(response.status).toBe(200)
      const capabilities = await response.json()
      expect(capabilities.features.includes("lattice")).toBe(selected)
      const spec = await Server.openapi()
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0)
    })
  })
}
