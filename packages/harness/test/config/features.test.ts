import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { retireFeaturePreferences } from "../../src/config/feature-migration"
import { testRuntime } from "../support/runtime"
import { runtimeHome } from "../support/runtime-home"
import { readFeaturePreferences } from "@ericsanchezok/synergy-util/feature-config"
import { ConfigImport } from "../../src/config/import"
import { ConfigExport } from "../../src/config/export"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

test("feature preferences are global, replace lists, and preserve dormant business configuration", async () => {
  await using home = await runtimeHome()
  const root = path.join(home.host.root, "config")
  const business = path.join(root, "synergy.d/120-runtime.jsonc")
  await Bun.write(business, JSON.stringify({ boss: { enabled: true, persona: "custom", future: { retained: true } } }))
  await using runtime = await testRuntime({ home: home.host.home })
  await runtime.run(async () => {
    expect(await readFeaturePreferences(root)).toEqual({ optIn: [] })
    expect(ConfigDomain.byId().get("features")?.globalOnly).toBe(true)
    await Config.domainUpdate("features", { features: { optIn: ["boss", "lattice"] } })
    expect((await Config.global()).features?.optIn).toEqual(["boss", "lattice"])
    await Config.domainUpdate("features", { features: { optIn: [] } })
    expect((await Config.global()).features?.optIn).toEqual([])
    await Config.domainUpdate("runtime", { compaction: { auto: false } })
    expect((await Bun.file(business).json()).boss).toEqual({
      enabled: true,
      persona: "custom",
      future: { retained: true },
    })
    await ConfigImport.apply({
      config: { compaction: { auto: true } },
      only: ["runtime"],
      mode: "replace-domain",
      yes: true,
    })
    expect((await Bun.file(business).json()).boss).toEqual({
      enabled: true,
      persona: "custom",
      future: { retained: true },
    })
    await expect(
      Config.domainUpdate(
        "features",
        { features: { optIn: ["boss"] } },
        { root: path.join(home.host.home, "project/.synergy") },
      ),
    ).rejects.toThrow("global")
  })
})

test("graduation cleanup is idempotent and preserves other choices, comments and business data", async () => {
  await using home = await runtimeHome()
  const root = path.join(home.host.root, "config")
  const filename = path.join(root, "synergy.d/140-features.jsonc")
  await Bun.write(filename, '// retained comment\n{ "features": { "optIn": ["graduated", "boss", "uninstalled"] } }')
  expect(await retireFeaturePreferences(root, ["graduated"])).toBe(true)
  expect(await readFeaturePreferences(root)).toEqual({ optIn: ["boss", "uninstalled"] })
  const once = await Bun.file(filename).text()
  expect(once).toContain("retained comment")
  expect(await retireFeaturePreferences(root, ["graduated"])).toBe(false)
  expect(await Bun.file(filename).text()).toBe(once)
})

test("feature import and export replace choices and reject project overrides before writing", async () => {
  await using home = await runtimeHome()
  await using runtime = await testRuntime({ home: home.host.home })
  await runtime.run(async () => {
    await Config.domainUpdate("features", { features: { optIn: ["boss", "uninstalled"] } })
    const exported = await ConfigExport.build({ only: ["features"] })
    expect(exported.config.features).toEqual({ optIn: ["boss", "uninstalled"] })
    await ConfigImport.apply({ config: { features: { optIn: [] } }, only: ["features"], yes: true })
    expect((await readFeaturePreferences(path.join(home.host.root, "config"))).optIn).toEqual([])
    await ConfigImport.apply({ config: exported.config, only: ["features"], yes: true })
    expect((await readFeaturePreferences(path.join(home.host.root, "config"))).optIn).toEqual(["boss", "uninstalled"])
    await ConfigImport.apply({ config: { features: { optIn: [] } }, only: ["features"], mode: "append", yes: true })
    expect((await readFeaturePreferences(path.join(home.host.root, "config"))).optIn).toEqual([])
    await using project = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await project.scope(),
      fn: () =>
        expect(
          ConfigImport.apply({ config: exported.config, only: ["features"], scope: "project", yes: true }),
        ).rejects.toThrow("global"),
    })
    expect(await Bun.file(path.join(project.path, ".synergy/synergy.d/140-features.jsonc")).exists()).toBe(false)
  })
})
