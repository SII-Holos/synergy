import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerConfig as registerChannels } from "@ericsanchezok/synergy-channels/config-schema"
import { registerConfig as registerFeishu } from "@ericsanchezok/synergy-channel-feishu/config-schema"
import { registerConfig as registerGithub } from "@ericsanchezok/synergy-channel-github/config-schema"

function register(github: boolean) {
  registerChannels()
  registerFeishu()
  if (github) registerGithub()
  ConfigExtensions.completeRegistration()
}

test("editing Feishu hides but preserves an unloaded GitHub Channel account", async () => {
  await using home = await runtimeHome()
  const feishu = { type: "feishu", accounts: { main: { appId: "test-app", appSecret: "test-secret", enabled: true } } }
  const github = {
    type: "github",
    accounts: { repo: { repositories: ["acme/project"], workspaceDir: home.host.home, enabled: false } },
  }
  {
    await using installed = await testRuntime({ home: home.host.home, register: () => register(true) })
    await installed.run(async () => {
      await Config.domainUpdate("channels", { channel: { feishu, github } })
    })
  }
  let retained: unknown
  {
    await using absent = await testRuntime({ home: home.host.home, register: () => register(false) })
    await absent.run(async () => {
      const file = ConfigDomain.filepath("channels")
      retained = (await Bun.file(file).json()).channel.github
      expect((await Config.domainGet("channels")).channel?.github).toBeUndefined()
      expect((await Config.globalResolved()).channel?.github).toBeUndefined()
      expect((await Config.domainReadForExport("channels")).config.channel?.github).toBeUndefined()
      for (const mode of ["merge", "replace-domain"] as const) {
        await Config.domainUpdate(
          "channels",
          { channel: { feishu: { ...feishu, accounts: { main: { ...feishu.accounts.main, enabled: false } } } } },
          { mode },
        )
        expect((await Bun.file(file).json()).channel.github).toEqual(retained)
        expect((await Config.domainGet("channels")).channel?.github).toBeUndefined()
      }
      await expect(Config.domainUpdate("channels", { channel: { github } })).rejects.toThrow()
      expect((await Bun.file(file).json()).channel.github).toEqual(retained)
    })
  }
  {
    await using installed = await testRuntime({ home: home.host.home, register: () => register(true) })
    await installed.run(async () => {
      expect((await Config.domainGet("channels")).channel?.github as unknown).toEqual(retained)
      expect((await Config.domainGet("channels")).channel?.feishu.accounts.main.enabled).toBe(false)
    })
  }
})
