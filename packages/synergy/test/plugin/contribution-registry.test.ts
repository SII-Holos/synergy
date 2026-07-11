import { describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, event } from "@ericsanchezok/synergy-plugin"
import z from "zod"
import { ContributionAdapterRegistry } from "../../src/plugin/contribution-registry"

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
})
