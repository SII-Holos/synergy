import { describe, expect, test } from "bun:test"
import { cliCommand, compilePluginManifest, definePlugin, event } from "@ericsanchezok/synergy-plugin"
import z from "zod"
import { ContributionAdapterRegistry, pluginContributionAdapters } from "../../src/plugin/contribution-registry"

describe("ContributionAdapterRegistry", () => {
  test("adds new contribution kinds without changing the registration loop", () => {
    const registry = new ContributionAdapterRegistry()
    const registered: string[] = []
    registry.add({
      kind: "event",
      validate() {},
      register({ contribution }) {
        registered.push(contribution.id)
      },
    })
    const definition = definePlugin({
      id: "registry-test",
      version: "1.0.0",
      description: "Registry test",
      contributions: [event({ id: "changed", payload: z.object({}) })],
    })
    const manifest = compilePluginManifest(definition, { generation: "one" })
    registry.registerPlugin(definition.id, manifest)
    expect(registered).toEqual(["changed"])
    expect(registry.list(definition.id, "event")).toHaveLength(1)
  })

  test("registers executable CLI command contributions from a generated manifest", () => {
    const definition = definePlugin({
      id: "cli-registry-test",
      version: "1.0.0",
      description: "CLI registry test",
      capabilities: [{ id: "shell.execute" }],
      contributions: [
        cliCommand({
          id: "setup",
          description: "Configure the plugin",
          requires: ["shell.execute"],
          handler: async () => ({ exitCode: 0 }),
        }),
      ],
    })
    const manifest = compilePluginManifest(definition, {
      generation: "cli-registry-generation",
      runtime: { entry: "runtime/index.js", sha256: "a".repeat(64) },
    })

    try {
      expect(() => pluginContributionAdapters.registerPlugin(definition.id, manifest)).not.toThrow()
      expect(pluginContributionAdapters.list(definition.id, "cli.command")).toHaveLength(1)
    } finally {
      pluginContributionAdapters.unregisterPlugin(definition.id)
    }
  })
})
