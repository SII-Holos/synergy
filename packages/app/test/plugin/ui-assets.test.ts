import { describe, expect, test } from "bun:test"
import { synergyTheme } from "@ericsanchezok/synergy-ui/theme"
import type { PluginContribution } from "../../src/plugin/api"
import { injectPluginStylesheet, loadPluginUIAssets, resolvePluginIconReference } from "../../src/plugin/ui-assets"

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
  const serverUrl = "https://example.test/proxy/4096"

  test("starts every asset request before waiting for individual responses", async () => {
    const requests: string[] = []
    const resolvers: Array<(response: Response) => void> = []
    const loading = loadPluginUIAssets([contribution("one"), contribution("two")], {
      serverUrl,
      fetcher: (url) => {
        requests.push(url)
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })

    await Promise.resolve()
    expect(requests).toHaveLength(2)
    expect(requests).toEqual([
      `${serverUrl}/plugin/assets/one/generation-one/theme.json`,
      `${serverUrl}/plugin/assets/two/generation-one/theme.json`,
    ])
    for (const resolve of resolvers) resolve(Response.json({ ...synergyTheme, id: "theme" }))
    const result = await loading
    expect(result.errors).toEqual([])
    expect([...result.themes.keys()].sort()).toEqual(["one:theme", "two:theme"])
  })

  test("loads themes and icons before registration", async () => {
    const input = contribution("assets")
    input.contributions.push({ kind: "ui.icon", id: "mark", path: "./mark.svg" })
    const result = await loadPluginUIAssets([input], {
      serverUrl,
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
      serverUrl,
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
      serverUrl,
      fetcher: async () => Response.json(invalid),
    })
    expect(result.themes.size).toBe(0)
    expect(result.errors[0]?.message).toContain("Cyclic theme token reference")
  })

  test("reports empty icon assets before registration", async () => {
    const input = contribution("empty-icon")
    input.contributions = [{ kind: "ui.icon", id: "mark", path: "./mark.svg" }]
    const result = await loadPluginUIAssets([input], {
      serverUrl,
      fetcher: async () => new Response(""),
    })

    expect(result.icons.size).toBe(0)
    expect(result.errors[0]?.message).toContain("empty SVG asset")
  })

  test("requires the asset and manifest theme ids to match", async () => {
    const result = await loadPluginUIAssets([contribution("mismatch")], {
      serverUrl,
      fetcher: async () => Response.json({ ...synergyTheme, id: "different" }),
    })
    expect(result.themes.size).toBe(0)
    expect(result.errors[0]?.message).toContain('does not match contribution id "theme"')
  })

  test("collects the sibling stylesheet of the UI artifact when present", async () => {
    const input = contribution("styled")
    input.uiArtifact = { entry: "ui/index.js", sha256: "abc" }
    const requested: string[] = []
    const result = await loadPluginUIAssets([input], {
      serverUrl,
      fetcher: async (url) => {
        requested.push(url)
        if (url.endsWith(".css")) return new Response("body { color: red }", { status: 200 })
        return Response.json({ ...synergyTheme, id: "theme" })
      },
    })
    expect(result.stylesheets.get("styled")).toBe("ui/index.css")
    expect(requested).toContain(`${serverUrl}/plugin/assets/styled/generation-one/ui/index.css`)
    expect(result.errors).toEqual([])
  })

  test("skips the stylesheet when the UI bundle has no sibling CSS", async () => {
    const input = contribution("plain")
    input.uiArtifact = { entry: "ui/index.js", sha256: "abc" }
    const result = await loadPluginUIAssets([input], {
      serverUrl,
      fetcher: async (url) =>
        url.endsWith(".css")
          ? new Response("not found", { status: 404 })
          : Response.json({ ...synergyTheme, id: "theme" }),
    })
    expect(result.stylesheets.size).toBe(0)
    expect(result.errors).toEqual([])
  })

  test("reports stylesheet load failures without dropping theme or icon assets", async () => {
    const input = contribution("broken-css")
    input.uiArtifact = { entry: "ui/index.js", sha256: "abc" }
    input.contributions.push({ kind: "ui.icon", id: "mark", path: "./mark.svg" })
    const result = await loadPluginUIAssets([input], {
      serverUrl,
      fetcher: async (url) => {
        if (url.endsWith(".svg")) return new Response("<svg></svg>")
        if (url.endsWith(".css")) return new Response("error", { status: 500 })
        return Response.json({ ...synergyTheme, id: "theme" })
      },
    })
    expect(result.stylesheets.size).toBe(0)
    expect(result.icons.has("broken-css:mark")).toBe(true)
    expect(result.errors[0]?.message).toContain("UI stylesheet failed to load")
  })

  test("injects the stylesheet link into the document head and removes it on dispose", () => {
    const dispose = injectPluginStylesheet("https://example.test/proxy/4096/plugin/assets/demo/gen/ui/index.css")
    const links = [...document.head.querySelectorAll("link[rel='stylesheet']")]
    const injected = links.find((link) => link.getAttribute("href")?.endsWith("ui/index.css"))
    expect(injected).toBeDefined()
    expect(injected!.getAttribute("rel")).toBe("stylesheet")

    dispose()
    expect([...document.head.querySelectorAll("link[rel='stylesheet']")].some((link) => link === injected)).toBe(false)
  })

  test("dispose is idempotent and does not remove unrelated stylesheets", () => {
    const unrelated = document.createElement("link")
    unrelated.rel = "stylesheet"
    unrelated.href = "https://example.test/app.css"
    document.head.appendChild(unrelated)
    const dispose = injectPluginStylesheet("https://example.test/proxy/4096/plugin/assets/demo/gen/ui/index.css")
    dispose()
    dispose()
    expect(document.head.contains(unrelated)).toBe(true)
    unrelated.remove()
  })
})
