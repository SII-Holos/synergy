import { describe, expect, test } from "bun:test"
import { cliCommand, compilePluginManifest, definePlugin, event, slot } from "@ericsanchezok/synergy-plugin"
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

test("registers ui.slot contributions from a generated manifest", () => {
  const definition = definePlugin({
    id: "slot-registry-test",
    version: "1.0.0",
    description: "Slot registry test",
    contributions: [
      slot({
        id: "footer",
        slot: "app.footer",
        label: "Footer",
        component: { source: "./src/ui.tsx", exportName: "Footer" },
      }),
    ],
  })
  const manifest = compilePluginManifest(definition, {
    generation: "slot-registry-generation",
    ui: { entry: "ui/index.js", sha256: "a".repeat(64) },
  })

  try {
    expect(() => pluginContributionAdapters.registerPlugin(definition.id, manifest)).not.toThrow()
    expect(pluginContributionAdapters.list(definition.id, "ui.slot")).toHaveLength(1)
  } finally {
    pluginContributionAdapters.unregisterPlugin(definition.id)
  }
})

test("failed validation or registration retains the previous contribution generation", () => {
  const registry = new ContributionAdapterRegistry()
  const live = new Set<string>()
  registry.add({
    kind: "event",
    validate({ contribution }) {
      if (contribution.id === "invalid") throw new Error("invalid event")
    },
    register({ contribution }) {
      if (contribution.id === "broken") throw new Error("registration failed")
      live.add(contribution.id)
      return () => {
        live.delete(contribution.id)
      }
    },
  })
  const build = (...ids: string[]) =>
    compilePluginManifest(
      definePlugin({
        id: "atomic-registry",
        version: "1.0.0",
        description: "Atomic registry",
        contributions: ids.map((id) => event({ id, payload: z.object({}) })),
      }),
      { generation: ids.join("-") },
    )
  registry.registerPlugin("atomic-registry", build("first"))
  expect(() => registry.registerPlugin("atomic-registry", build("invalid"))).toThrow("invalid event")
  expect([...live]).toEqual(["first"])
  expect(() => registry.registerPlugin("atomic-registry", build("partial", "broken"))).toThrow("registration failed")
  expect([...live]).toEqual(["first"])
  expect(registry.list("atomic-registry", "event").map((item) => item.id)).toEqual(["first"])
  registry.unregisterPlugin("atomic-registry")
  expect([...live]).toEqual([])
})

test("cleanup failure restores the prior generation and releases every owned contribution", () => {
  const registry = new ContributionAdapterRegistry()
  const live = new Set<string>()
  let failCleanup = true
  registry.add({
    kind: "event",
    validate() {},
    register({ contribution }) {
      live.add(contribution.id)
      return () => {
        live.delete(contribution.id)
        if (contribution.id === "first" && failCleanup) {
          failCleanup = false
          throw new Error("cleanup failed")
        }
      }
    },
  })
  const build = (...ids: string[]) =>
    compilePluginManifest(
      definePlugin({
        id: "cleanup-registry",
        version: "1.0.0",
        description: "Cleanup registry",
        contributions: ids.map((id) => event({ id, payload: z.object({}) })),
      }),
      { generation: ids.join("-") },
    )
  registry.registerPlugin("cleanup-registry", build("first", "second"))
  expect(() => registry.registerPlugin("cleanup-registry", build("new"))).toThrow("cleanup")
  expect([...live]).toEqual(["first", "second"])
  expect(registry.list("cleanup-registry", "event").map((item) => item.id)).toEqual(["first", "second"])
  registry.unregisterPlugin("cleanup-registry")
  expect([...live]).toEqual([])
})
