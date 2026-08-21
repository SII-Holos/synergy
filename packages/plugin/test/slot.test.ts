import { describe, expect, test } from "bun:test"
import { PluginManifest, compilePluginManifest, definePlugin, hasTrustedUIComponent, slot } from "../src/index"

describe("ui.slot contribution", () => {
  test("slot() helper produces a ui.slot contribution with default order", () => {
    const contribution = slot({
      id: "status-indicator",
      slot: "sidebar.footer",
      label: "Status",
      component: { source: "./src/ui.tsx", exportName: "StatusIndicator" },
    })
    expect(contribution).toMatchObject({
      kind: "ui.slot",
      id: "status-indicator",
      slot: "sidebar.footer",
      label: "Status",
      order: 1000,
      component: { source: "./src/ui.tsx", exportName: "StatusIndicator" },
    })
  })

  test("slot() accepts an explicit order and a when condition", () => {
    const contribution = slot({
      id: "welcome",
      slot: "session.empty",
      label: "Welcome",
      order: 50,
      when: { session: true },
      component: { source: "./src/ui.tsx", exportName: "Welcome" },
    })
    expect(contribution.order).toBe(50)
    expect(contribution.when).toEqual({ session: true })
  })

  test("compiled manifest preserves the slot contribution and marks trusted UI", () => {
    const plugin = definePlugin({
      id: "slot-demo",
      name: "Slot Demo",
      version: "1.0.0",
      description: "Slot contribution demo",
      capabilities: [],
      contributions: [
        slot({
          id: "status",
          slot: "sidebar.footer",
          label: "Status",
          component: { source: "./src/ui.tsx", exportName: "Status" },
        }),
      ],
    })
    const manifest = compilePluginManifest(plugin, {
      generation: "generation-1",
      ui: { entry: "ui/index.js", sha256: "ui-hash" },
    })
    expect(manifest.contributions).toHaveLength(1)
    expect(manifest.contributions[0]).toMatchObject({
      kind: "ui.slot",
      id: "status",
      slot: "sidebar.footer",
      component: { entry: "ui/index.js", exportName: "Status" },
    })
    expect(hasTrustedUIComponent(manifest.contributions[0])).toBe(true)
  })

  test("manifest validation rejects an unknown field on a slot contribution", () => {
    const base = compilePluginManifest(
      definePlugin({
        id: "slot-invalid",
        name: "Slot Invalid",
        version: "1.0.0",
        description: "Invalid slot contribution",
        capabilities: [],
        contributions: [
          slot({
            id: "status",
            slot: "sidebar.footer",
            label: "Status",
            component: { source: "./src/ui.tsx", exportName: "Status" },
          }),
        ],
      }),
      { generation: "generation-1", ui: { entry: "ui/index.js", sha256: "ui-hash" } },
    )
    const raw = JSON.parse(JSON.stringify(base)) as {
      contributions: Array<Record<string, unknown>>
    }
    raw.contributions[0].bogus = "field"
    expect(PluginManifest.safeParse(raw).success).toBe(false)
  })

  test("manifest validation rejects a slot contribution missing the slot name", () => {
    const base = compilePluginManifest(
      definePlugin({
        id: "slot-missing",
        name: "Slot Missing",
        version: "1.0.0",
        description: "Missing slot name",
        capabilities: [],
        contributions: [
          slot({
            id: "status",
            slot: "sidebar.footer",
            label: "Status",
            component: { source: "./src/ui.tsx", exportName: "Status" },
          }),
        ],
      }),
      { generation: "generation-1", ui: { entry: "ui/index.js", sha256: "ui-hash" } },
    )
    const raw = JSON.parse(JSON.stringify(base)) as {
      contributions: Array<Record<string, unknown>>
    }
    delete raw.contributions[0].slot
    expect(PluginManifest.safeParse(raw).success).toBe(false)
  })
})
