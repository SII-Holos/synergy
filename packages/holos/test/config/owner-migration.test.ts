import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { ConfigReferenceMigration } from "@ericsanchezok/synergy-harness/config/reference-migration"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { holos } from "../../src/component"
import { Holos } from "../../src/config-schema"

function register(selected: boolean) {
  registerLocalRuntime()
  if (selected) holos().register()
  ConfigExtensions.completeRegistration()
}

function open(selected: boolean, home?: string) {
  return testRuntime({ home, composition: { register: () => register(selected) } })
}

const legacy = {
  channel: {
    holos: {
      type: "holos",
      accounts: { default: { enabled: false } },
      future: { retained: true },
    },
    unloaded: { accounts: { untouched: { enabled: true } } },
  },
  holos_friend_reply_model: "retired/model",
  otherOwner: { retained: [1, 2] },
}

for (const source of ["legacy", "domain"] as const) {
  test(`${source} Holos settings wait for their owner and survive removal and reinstall`, async () => {
    await using home = await runtimeHome()
    const configRoot = path.join(home.host.root, "config")
    const sourceFile = path.join(configRoot, source === "legacy" ? "synergy.jsonc" : "synergy.d/90-channels.jsonc")
    const raw = JSON.stringify(legacy, null, 2) + "\n"
    await Bun.write(sourceFile, raw)
    {
      await using core = await open(false, home.host.home)
      await core.run(async () => {
        expect(await Bun.file(sourceFile).text()).toBe(raw)
        expect(await Config.globalResolved()).not.toHaveProperty("holos")
        const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-config"])
        expect(receipt["20260410-config-holos-top-level"]).toBeGreaterThan(0)
        expect(receipt["20260413-config-holos-legacy-cleanup"]).toBeGreaterThan(0)
        expect(receipt["20260619-config-remove-holos-friend-reply-model"]).toBeGreaterThan(0)
      })
    }
    {
      await using selected = await open(true, home.host.home)
      await selected.run(async () => {
        expect((await Config.globalResolved()).holos).toEqual({
          enabled: false,
          apiUrl: "https://api.holosai.io",
          wsUrl: "wss://api.holosai.io",
          portalUrl: "https://www.holosai.io",
        })
        const stored = await Bun.file(sourceFile).json()
        expect(stored.channel).toEqual({
          holos: { future: legacy.channel.holos.future },
          unloaded: legacy.channel.unloaded,
        })
        expect(stored.otherOwner).toEqual(legacy.otherOwner)
        expect(stored).not.toHaveProperty("holos_friend_reply_model")
        const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-holos"])
        expect(receipt["20261012-holos-config-owner"]).toBeGreaterThan(0)
        await Config.domainUpdate("holos", { holos: Holos.parse({ enabled: true }) })
      })
    }
    const retained = await Bun.file(sourceFile).text()
    {
      await using core = await open(false, home.host.home)
      await core.run(async () => {
        expect(await Config.globalResolved()).not.toHaveProperty("holos")
        await Config.domainUpdate("general", { logLevel: "WARN" }, { mode: "replace-domain" })
        expect(await Bun.file(sourceFile).text()).toBe(retained)
      })
    }
    {
      await using reinstalled = await open(true, home.host.home)
      await reinstalled.run(async () => {
        expect((await Config.globalResolved()).holos?.enabled).toBe(true)
        expect(await Bun.file(sourceFile).text()).toBe(retained)
      })
    }
  })
}

test("Holos catchup preserves an explicit destination and retries a failed destination write", async () => {
  await using runtime = await open(true)
  await runtime.run(async () => {
    const source = path.join(Global.Path.config, "synergy.d", "90-channels.jsonc")
    const target = ConfigDomain.filepath("holos")
    await Bun.write(source, JSON.stringify(legacy, null, 2) + "\n")
    await fs.mkdir(target, { recursive: true })
    const before = await Bun.file(source).text()
    await expect(ConfigReferenceMigration.file(source)).rejects.toThrow()
    expect(await Bun.file(source).text()).toBe(before)
    await fs.rmdir(target)
    await Bun.write(target, JSON.stringify({ holos: { enabled: true, apiUrl: "https://holos.example.test" } }))
    await ConfigReferenceMigration.file(source)
    const after = await Bun.file(source).text()
    expect(await Bun.file(target).json()).toMatchObject({
      holos: { enabled: true, apiUrl: "https://holos.example.test" },
    })
    expect(await Bun.file(source).json()).toEqual({
      channel: { holos: { future: legacy.channel.holos.future }, unloaded: legacy.channel.unloaded },
      otherOwner: legacy.otherOwner,
    })
    await ConfigReferenceMigration.file(source)
    expect(await Bun.file(source).text()).toBe(after)
  })
})
