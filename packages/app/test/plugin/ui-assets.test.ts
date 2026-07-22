import { describe, expect, test } from "bun:test"
import { synergyTheme } from "@ericsanchezok/synergy-ui/theme"
import type { PluginContribution } from "../../src/plugin/api"
import { loadPluginUIAssets, resolvePluginIconReference } from "../../src/plugin/ui-assets"

function contribution(pluginId: string, themeId = "theme"): PluginContribution {
  return {
    pluginId,
    name: pluginId,
    version: "1.0.0",
    generation: "generation-one",
    scopeId: "scope-one",
    capabilities: [],
    contributions: [{ kind: "ui.theme", id: themeId, label: pluginId, path: `./${themeId}.json` }],
  }
}

describe("plugin UI asset loading", () => {
  test("starts every asset request before waiting for individual responses", async () => {
    const requests: string[] = []
    const resolvers: Array<(response: Response) => void> = []
    const loading = loadPluginUIAssets([contribution("one"), contribution("two")], {
      fetcher: (url) => {
        requests.push(url)
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })

    await Promise.resolve()
    expect(requests).toHaveLength(2)
    for (const resolve of resolvers) resolve(Response.json({ ...synergyTheme, id: "theme" }))
    const result = await loading
    expect(result.errors).toEqual([])
    expect([...result.themes.keys()].sort()).toEqual(["one:theme", "two:theme"])
  })

  test("loads themes and icons before registration", async () => {
    const input = contribution("assets")
    input.contributions.push({ kind: "ui.icon", id: "mark", path: "./mark.svg" })
    const result = await loadPluginUIAssets([input], {
      fetcher: async (url) =>
        url.endsWith(".svg") ? new Response("<svg></svg>") : Response.json({ ...synergyTheme, id: "theme" }),
    })

    expect(result.errors).toEqual([])
    expect(result.themes.has("assets:theme")).toBe(true)
    expect(result.icons.get("assets:mark")).toEqual({
      name: "assets:mark",
      svgContent: "<svg></svg>",
      pluginId: "assets",
    })
    expect(resolvePluginIconReference(input, "mark")).toBe("assets:mark")
    expect(resolvePluginIconReference(input, "circle")).toBe("circle")
  })

  test("keeps same-named icons from different plugins distinct", async () => {
    const one = contribution("one")
    const two = contribution("two")
    one.contributions = [{ kind: "ui.icon", id: "logo", path: "./logo.svg" }]
    two.contributions = [{ kind: "ui.icon", id: "logo", path: "./logo.svg" }]

    const result = await loadPluginUIAssets([one, two], {
      fetcher: async () => new Response("<svg></svg>"),
    })

    expect([...result.icons.values()].map((icon) => icon.name).sort()).toEqual(["one:logo", "two:logo"])
    expect(resolvePluginIconReference(one, "logo")).toBe("one:logo")
    expect(resolvePluginIconReference(two, "logo")).toBe("two:logo")
  })

  test("rejects resolver-invalid themes without exposing them", async () => {
    const invalid = {
      ...synergyTheme,
      id: "theme",
      dark: {
        ...synergyTheme.dark,
        overrides: { ...synergyTheme.dark.overrides, "border-base": "var(--border-base)" },
      },
    }
    const result = await loadPluginUIAssets([contribution("invalid")], {
      fetcher: async () => Response.json(invalid),
    })
    expect(result.themes.size).toBe(0)
    expect(result.errors[0]?.message).toContain("Cyclic theme token reference")
  })

  test("reports empty icon assets before registration", async () => {
    const input = contribution("empty-icon")
    input.contributions = [{ kind: "ui.icon", id: "mark", path: "./mark.svg" }]
    const result = await loadPluginUIAssets([input], {
      fetcher: async () => new Response(""),
    })

    expect(result.icons.size).toBe(0)
    expect(result.errors[0]?.message).toContain("empty SVG asset")
  })

  test("requires the asset and manifest theme ids to match", async () => {
    const result = await loadPluginUIAssets([contribution("mismatch")], {
      fetcher: async () => Response.json({ ...synergyTheme, id: "different" }),
    })
    expect(result.themes.size).toBe(0)
    expect(result.errors[0]?.message).toContain('does not match contribution id "theme"')
  })
})
