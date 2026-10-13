import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { holos } from "@ericsanchezok/synergy-holos/component"
import { accountConfigured } from "@ericsanchezok/synergy-holos/holos/account-configured"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { channelClarus } from "../src/component"

for (const selected of [false, true]) {
  test(`Holos account provisioning selects Clarus only when its component is ${selected ? "present" : "absent"}`, async () => {
    await using runtime = await testRuntime({
      composition: {
        register() {
          localRuntime({ workers: false, environment: false }).register()
          holos().register()
          if (!selected) return
          channels().register()
          agenda().register()
          channelClarus().register()
        },
      },
    })
    await runtime.run(async () => {
      await accountConfigured("agent_fixture")
      const config = await Config.globalResolved()
      if (!selected) {
        expect(config.channel).toBeUndefined()
        return
      }
      expect(config.channel?.clarus?.accounts.agent_fixture).toEqual({ enabled: false })
      await Config.domainUpdate("channels", {
        channel: { clarus: { type: "clarus", accounts: { agent_fixture: { enabled: true } } } },
      })
      await accountConfigured("agent_fixture")
      expect((await Config.globalResolved()).channel?.clarus?.accounts.agent_fixture).toEqual({ enabled: true })
    })
  })
}
