import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { server } from "@ericsanchezok/synergy-server/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { channelFeishu } from "../src/component"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"

const components = RuntimeComponents.resolve([
  localRuntime({ workers: false, environment: false }),
  channels(),
  channelFeishu(),
])
const adapters = await Promise.all(
  components.flatMap((component) => (component.adapters?.http ? [import(component.adapters.http.href)] : [])),
)
for (const selected of [false, true]) {
  test(`channel-feishu HTTP capability follows explicit composition after its adapters were imported (${selected})`, async () => {
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
      expect(ToolRegistry.toolProviderIDs().includes("channel-feishu")).toBe(selected)
      expect(!!SessionModePolicy.visibility({ toolName: "channel_reaction_only" })).toBe(selected)
      const response = await Server.App().request("/global/capabilities")
      expect(response.status).toBe(200)
      const capabilities = await response.json()
      expect(capabilities.features.includes("channel-feishu")).toBe(selected)
      const spec = await Server.openapi()
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0)
    })
  })
}
