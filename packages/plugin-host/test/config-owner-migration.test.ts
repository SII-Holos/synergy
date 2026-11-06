import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "../src/component"

test("legacy plugin settings and credentials stay dormant until Plugin Host is installed", async () => {
  await using home = await runtimeHome()
  const source = path.join(home.host.root, "config", "synergy.jsonc")
  const legacy = {
    sii: { enable: false, defaultSpecId: "saved-spec", future: { retained: true }, shared: "legacy" },
    pluginConfig: { inspire: { shared: "explicit", custom: [1, 2] } },
    pluginApprovalPolicy: { future: true },
    absentOwner: { retained: true },
  }
  const raw = JSON.stringify(legacy, null, 2)
  await Bun.write(source, raw)
  const oldAuth = path.join(home.host.root, "data", "auth", "inspire.json")
  const newAuth = path.join(home.host.root, "data", "plugin", "inspire", "auth.json")
  const oldCache = path.join(home.host.root, "cache", "inspire-token.json")
  const newCache = path.join(home.host.root, "cache", "plugin", "inspire", "inspire-token.json")
  const credentials = { username: "fixture-user", password: "fixture-value" }
  await Bun.write(oldAuth, JSON.stringify(credentials))
  await Bun.write(oldCache, JSON.stringify({ retained: true }))
  let retained = ""
  for (const selected of [false, true, false, true]) {
    await using runtime = await testRuntime({
      home: home.host.home,
      composition: RuntimeComponents.compose([
        localRuntime({ workers: false, environment: false }),
        ...(selected ? [plugins()] : []),
      ]),
    })
    await runtime.run(async () => {
      const config = await Config.globalResolved()
      if (!selected) {
        expect(config).not.toHaveProperty("pluginConfig")
        expect(await Bun.file(source).text()).toBe(retained || raw)
        if (!retained) {
          expect(await Bun.file(newAuth).exists()).toBe(false)
          expect(await Bun.file(newCache).exists()).toBe(false)
        }
      } else {
        expect(config.pluginConfig?.inspire).toEqual({ ...legacy.sii, ...legacy.pluginConfig.inspire })
        expect(await Bun.file(newAuth).json()).toEqual({
          "inspire-username": credentials.username,
          "inspire-password": credentials.password,
        })
        expect(await Bun.file(newCache).json()).toEqual({ value: { retained: true } })
        const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-plugin-config"])
        expect(receipt["20261012-plugin-config-owner"]).toBeGreaterThan(0)
        if (retained) expect(await Bun.file(source).text()).toBe(retained)
        retained = await Bun.file(source).text()
      }
      const stored = await Bun.file(source).json()
      expect(stored.pluginApprovalPolicy).toEqual(legacy.pluginApprovalPolicy)
      expect(stored.absentOwner).toEqual(legacy.absentOwner)
      expect(await Bun.file(oldAuth).json()).toEqual(credentials)
      expect(await Bun.file(oldCache).json()).toEqual({ retained: true })
      const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-config"])
      expect(receipt["20260422-config-sii-to-plugin"]).toBeGreaterThan(0)
    })
  }
}, 30_000)

for (const sourceFirst of [false, true]) {
  test(`exclusive plugin configuration migrates credentials and cache without consuming file authority (${sourceFirst})`, async () => {
    await using home = await runtimeHome()
    const source = path.join(home.host.root, "config", "synergy.jsonc")
    const legacy = { sii: { enable: false, future: true }, unknownOwner: { retained: true } }
    const raw = JSON.stringify(legacy)
    const oldAuth = path.join(home.host.root, "data", "auth", "inspire.json")
    const newAuth = path.join(home.host.root, "data", "plugin", "inspire", "auth.json")
    const oldCache = path.join(home.host.root, "cache", "inspire-token.json")
    const newCache = path.join(home.host.root, "cache", "plugin", "inspire", "inspire-token.json")
    await Bun.write(source, raw)
    await Bun.write(oldAuth, JSON.stringify({ username: "fixture", password: "retained-value" }))
    await Bun.write(oldCache, JSON.stringify({ fixture: true }))
    const open = (exclusive: boolean) => {
      const composition = RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), plugins()])
      return testRuntime({
        home: home.host.home,
        env: { SYNERGY_CWD: home.host.home },
        composition: {
          ...composition,
          register() {
            if (exclusive && sourceFirst) ConfigSource.register({ resolve: async () => ({}) })
            composition.register()
            if (exclusive && !sourceFirst) ConfigSource.register({ resolve: async () => ({}) })
          },
        },
      })
    }
    {
      await using host = await open(true)
      await host.run(async () => {
        expect(await Bun.file(source).text()).toBe(raw)
        expect(await Bun.file(newAuth).json()).toEqual({
          "inspire-username": "fixture",
          "inspire-password": "retained-value",
        })
        expect(await Bun.file(newCache).json()).toEqual({ value: { fixture: true } })
        const ledger = await Storage.read<Record<string, number>>(["meta", "migration", "log-plugin-config"])
        expect(ledger["20261012-plugin-config-owner"]).toBeUndefined()
        expect(ledger["20261012-plugin-legacy-stores-owner"]).toBeGreaterThan(0)
      })
    }
    await Bun.write(newAuth, JSON.stringify({ "inspire-password": "explicit-value" }))
    {
      await using local = await open(false)
      await local.run(async () => {
        expect((await Config.globalRaw()).pluginConfig?.inspire).toEqual(legacy.sii)
        expect((await Bun.file(source).json()).unknownOwner).toEqual(legacy.unknownOwner)
        expect(await Bun.file(newAuth).json()).toEqual({ "inspire-password": "explicit-value" })
        expect(await Bun.file(newCache).json()).toEqual({ value: { fixture: true } })
        const ledger = await Storage.read<Record<string, number>>(["meta", "migration", "log-plugin-config"])
        expect(ledger["20261012-plugin-config-owner"]).toBeGreaterThan(0)
        expect(ledger["20261012-plugin-legacy-stores-owner"]).toBeGreaterThan(0)
        expect(await Bun.file(oldAuth).json()).toEqual({ username: "fixture", password: "retained-value" })
        expect(await Bun.file(oldCache).json()).toEqual({ fixture: true })
      })
    }
  }, 30_000)
}
