import { describe, expect, test } from "bun:test"
import {
  compilePluginManifest,
  definePlugin,
  mcp,
  settings,
  type PluginManifestType,
} from "@ericsanchezok/synergy-plugin"
import { getPluginConfig, replacePluginConfig } from "../../src/plugin/config-store"
import { pluginContributionAdapters } from "../../src/plugin/contribution-registry"
import { mcpDeclarations } from "../../src/plugin/lifecycle"
import type { LoadedPlugin } from "../../src/plugin/loader"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

function manifest(pluginId: string): PluginManifestType {
  return compilePluginManifest(
    definePlugin({
      id: pluginId,
      version: "1.0.0",
      description: "Settings-conditioned MCP test plugin",
      contributions: [
        mcp({
          id: "components",
          enabledWhen: { setting: "componentsEnabled", equals: true },
          server: { type: "local", command: ["frontend-mcp"], startup: "eager" },
        }),
        settings({
          id: "settings",
          label: "Frontend Kit",
          group: "plugins",
          formSchema: {
            type: "object",
            properties: {
              componentsEnabled: {
                type: "boolean",
                default: true,
                title: "Components",
              },
            },
            additionalProperties: false,
          },
        }),
      ],
    }),
    { generation: "settings-conditioned-mcp" },
  )
}

function loadedPlugin(pluginManifest: PluginManifestType): LoadedPlugin {
  return {
    id: pluginManifest.id,
    name: pluginManifest.name,
    manifest: pluginManifest,
    pluginDir: "/plugin",
    source: "local",
    spec: "file:///plugin",
    enabledScopes: new Set(),
    contributionHealth: new Map(),
  }
}

describe("settings-conditioned MCP contributions", () => {
  test("uses schema defaults as the effective plugin config", async () => {
    await using tmp = await tmpdir({ config: {} })
    const pluginManifest = manifest("settings-defaults-test")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await getPluginConfig(pluginManifest.id, { manifest: pluginManifest })).toEqual({
          componentsEnabled: true,
        })

        await replacePluginConfig(pluginManifest.id, { componentsEnabled: false }, { manifest: pluginManifest })
        expect(await getPluginConfig(pluginManifest.id, { manifest: pluginManifest })).toEqual({
          componentsEnabled: false,
        })

        await replacePluginConfig(pluginManifest.id, { legacy: { componentsEnabled: false } })
        expect(await getPluginConfig(pluginManifest.id, { manifest: pluginManifest })).toEqual({
          componentsEnabled: true,
        })
      },
    })
  })

  test("includes eager MCP servers by default and removes them when disabled", async () => {
    await using tmp = await tmpdir({ config: {} })
    const pluginManifest = manifest("settings-mcp-filter-test")
    const plugin = loadedPlugin(pluginManifest)
    pluginContributionAdapters.registerPlugin(plugin.id, pluginManifest)

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          expect(await mcpDeclarations(plugin)).toEqual({
            components: expect.objectContaining({ startup: "eager" }),
          })

          await replacePluginConfig(plugin.id, { componentsEnabled: false }, { manifest: pluginManifest })
          expect(await mcpDeclarations(plugin)).toEqual({})
        },
      })
    } finally {
      pluginContributionAdapters.unregisterPlugin(plugin.id)
    }
  })
})
