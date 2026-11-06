import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { server } from "@ericsanchezok/synergy-server/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { github } from "@ericsanchezok/synergy-github/component"
import { channelGithub } from "../src/component"

const components = RuntimeComponents.resolve([
  localRuntime({ workers: false, environment: false }),
  channels(),
  github(),
  channelGithub(),
])
const adapters = await Promise.all(
  components.flatMap((component) => (component.adapters?.http ? [import(component.adapters.http.href)] : [])),
)
for (const selected of [false, true]) {
  test(`channel-github HTTP capability follows explicit composition after its adapters were imported (${selected})`, async () => {
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
      expect(capabilities.features.includes("channel-github")).toBe(selected)
      const spec = await Server.openapi()
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0)
    })
  })
}
