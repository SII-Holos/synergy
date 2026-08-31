import { describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, theme } from "@ericsanchezok/synergy-plugin"
import { computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { pathToFileURL } from "url"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { saveApproval } from "../../src/plugin/consent/approval-store"
import { getLoadedPlugins, resetAllPluginState } from "../../src/plugin/loader"
import { listGlobalThemePlugins } from "../../src/plugin/global-themes"

async function createThemePluginFixture(rootDir: string, pluginId: string): Promise<string> {
  const dir = path.join(rootDir, `plugin-${pluginId}`)
  await fs.mkdir(path.join(dir, "themes"), { recursive: true })
  await Bun.write(
    path.join(dir, "themes", "skin.json"),
    JSON.stringify({ id: "unused", name: "Skin", light: { seeds: {} }, dark: { seeds: {} } }),
  )
  const manifest = compilePluginManifest(
    definePlugin({
      id: pluginId,
      version: "1.0.0",
      description: "Theme fixture",
      contributions: [theme({ id: "skin", label: "Fixture Skin", path: "themes/skin.json" })],
    }),
    { generation: `${pluginId}-generation` },
  )
  await Bun.write(path.join(dir, "plugin.json"), JSON.stringify(manifest))
  await saveApproval({
    schemaVersion: 2,
    pluginId,
    source: "local",
    grant: { capabilities: [], contributionRequirements: [] },
    grantHash: computePermissionsHash(manifest, []),
    approvedAt: Date.now() - 1000,
    approvedBy: "user",
    trustTier: "declarative",
    approvedCapabilities: [],
  })
  return pathToFileURL(dir).href
}

describe("global theme aggregation", () => {
  test("aggregates ui.theme contributions across every activated scope", async () => {
    const rootA = await tmpdir()
    const rootB = await tmpdir()
    try {
      const specA = await createThemePluginFixture(rootA.path, "global-themes-a")
      const specB = await createThemePluginFixture(rootB.path, "global-themes-b")
      const tmpA = await tmpdir({ git: true, config: { plugin: [specA] } })
      const tmpB = await tmpdir({ git: true, config: { plugin: [specB] } })
      try {
        await resetAllPluginState()
        for (const tmp of [tmpA, tmpB]) {
          const scope = await tmp.scope()
          await ScopeContext.provide({ scope, fn: async () => void (await getLoadedPlugins()) })
        }

        const aggregated = listGlobalThemePlugins()
        expect(aggregated.map((entry) => entry.pluginId)).toEqual(["global-themes-a", "global-themes-b"])
        const entryA = aggregated[0]
        expect(entryA.enabledScopes).toHaveLength(1)
        expect(entryA.generation).toBe("global-themes-a-generation")
        expect(entryA.contributions).toHaveLength(1)
        expect(entryA.contributions[0]).toMatchObject({ kind: "ui.theme", id: "skin", path: "themes/skin.json" })
      } finally {
        await tmpA[Symbol.asyncDispose]()
        await tmpB[Symbol.asyncDispose]()
      }
    } finally {
      await rootA[Symbol.asyncDispose]()
      await rootB[Symbol.asyncDispose]()
      await resetAllPluginState()
    }
  })

  test("keeps the single catalog entry when the same plugin is enabled in two scopes", async () => {
    const root = await tmpdir()
    try {
      const spec = await createThemePluginFixture(root.path, "global-themes-shared")
      const tmpFirst = await tmpdir({ git: true, config: { plugin: [spec] } })
      const tmpSecond = await tmpdir({ git: true, config: { plugin: [spec] } })
      try {
        await resetAllPluginState()
        for (const tmp of [tmpFirst, tmpSecond]) {
          const scope = await tmp.scope()
          await ScopeContext.provide({ scope, fn: async () => void (await getLoadedPlugins()) })
        }

        const aggregated = listGlobalThemePlugins()
        expect(aggregated).toHaveLength(1)
        expect(aggregated[0].enabledScopes).toHaveLength(2)
      } finally {
        await tmpFirst[Symbol.asyncDispose]()
        await tmpSecond[Symbol.asyncDispose]()
      }
    } finally {
      await root[Symbol.asyncDispose]()
      await resetAllPluginState()
    }
  })

  test("drops plugins once no scope keeps them enabled", async () => {
    const root = await tmpdir()
    try {
      const spec = await createThemePluginFixture(root.path, "global-themes-cold")
      const tmp = await tmpdir({ git: true, config: { plugin: [spec] } })
      try {
        await resetAllPluginState()
        const scope = await tmp.scope()
        await ScopeContext.provide({ scope, fn: async () => void (await getLoadedPlugins()) })
        expect(listGlobalThemePlugins().map((entry) => entry.pluginId)).toContain("global-themes-cold")

        await resetAllPluginState()
        expect(listGlobalThemePlugins()).toEqual([])
      } finally {
        await tmp[Symbol.asyncDispose]()
      }
    } finally {
      await root[Symbol.asyncDispose]()
      await resetAllPluginState()
    }
  })
})
