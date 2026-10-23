import { composeWithExperiments } from "../support/selected-components"
import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { anima } from "@ericsanchezok/synergy-anima/component"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { holos } from "@ericsanchezok/synergy-holos/component"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"

const owners = {
  library: "20261012-library-config-owner",
  anima: "20261012-anima-config-owner",
  holos: "20261012-holos-config-owner",
  "mcp-config": "20261012-mcp-execution-config-owner",
  "boss-config": "20261012-boss-execution-config-owner",
  "plugin-config": "20261012-plugin-config-owner",
}

for (const sourceFirst of [false, true]) {
  test(`exclusive host leaves optional file configuration pending until local activation (${sourceFirst})`, async () => {
    await using home = await runtimeHome()
    const source = path.join(home.host.root, "config", "synergy.jsonc")
    const raw = JSON.stringify({
      library: { memory: { retrieval: false }, autonomy: false },
      channel: { holos: { enabled: false } },
      experimental: { mcp_timeout: 4567, boss_mode: false },
      sii: { enable: false, future: { retained: true } },
      unknownOwner: { retained: true },
    })
    await Bun.write(source, raw)
    const open = (exclusive: boolean) => {
      const composition = composeWithExperiments([
        localRuntime({ workers: false, environment: false }),
        library(),
        note(),
        agenda(),
        anima(),
        boss(),
        holos(),
        plugins(),
        mcp(),
      ])
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
        expect(await Config.globalRaw()).toEqual({})
        expect(await Bun.file(source).text()).toBe(raw)
        for (const [domain, id] of Object.entries(owners)) {
          expect(
            MigrationRegistry.list()
              .get(domain)
              ?.some((item) => item.id === id) ?? false,
          ).toBe(false)
          const [ledger] = await Storage.readMany<Record<string, number>>([["meta", "migration", `log-${domain}`]])
          expect(ledger?.[id]).toBeUndefined()
        }
        expect(
          (await Storage.read<Record<string, number>>(["meta", "migration", "log-library"]))[
            "20261012-library-home-scope"
          ],
        ).toBeGreaterThan(0)
      })
    }
    {
      await using local = await open(false)
      await local.run(async () => {
        const value = await Config.globalRaw()
        expect(value.library?.memory?.enabled).toBe(false)
        expect(value.anima?.enabled).toBe(false)
        expect(value.holos?.enabled).toBe(false)
        expect(value.mcpDefaults?.callTimeout).toBe(4567)
        expect(value.boss?.enabled).toBe(false)
        expect(value.pluginConfig?.inspire).toEqual({ enable: false, future: { retained: true } })
        expect((await Bun.file(source).json()).unknownOwner).toEqual({ retained: true })
        for (const [domain, id] of Object.entries(owners)) {
          expect(
            (await Storage.read<Record<string, number>>(["meta", "migration", `log-${domain}`]))[id],
          ).toBeGreaterThan(0)
        }
      })
    }
  }, 30_000)
}
