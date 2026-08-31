import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { compilePluginManifest, definePlugin, theme } from "@ericsanchezok/synergy-plugin"
import { computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { pathToFileURL } from "url"
import fs from "fs"
import path from "path"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { ScopeContext } from "../../src/scope/context"
import { saveApproval } from "../../src/plugin/consent/approval-store"
import { getLoadedPlugins, resetAllPluginState } from "../../src/plugin/loader"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function createThemePluginFixture(rootDir: string, pluginId: string): Promise<string> {
  const dir = path.join(rootDir, `plugin-${pluginId}`)
  fs.mkdirSync(path.join(dir, "themes"), { recursive: true })
  fs.writeFileSync(
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
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
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

describe("GET /plugin/ui/contributions/themes", () => {
  let app: ReturnType<typeof Server.App>
  let pluginRoot: Awaited<ReturnType<typeof tmpdir>>
  let projectTmp: Awaited<ReturnType<typeof tmpdir>>

  beforeAll(async () => {
    pluginRoot = await tmpdir()
    const spec = await createThemePluginFixture(pluginRoot.path, "route-theme-plugin")
    projectTmp = await tmpdir({ git: true, config: { plugin: [spec] } })
    app = await Server.App()
  })

  afterAll(async () => {
    await resetAllPluginState()
    await projectTmp[Symbol.asyncDispose]()
    await pluginRoot[Symbol.asyncDispose]()
  })

  test("returns the global theme list without any scope binding and stays stable across scope contexts", async () => {
    await resetAllPluginState()
    const scope = await projectTmp.scope()
    // Activate the project scope so its plugin enters the catalog.
    await ScopeContext.provide({ scope, fn: async () => void (await getLoadedPlugins()) })

    // The theme asset must resolve globally too: the registrar fetches it
    // without any scope hint, so the catalog fallback in the asset route is
    // what makes a project-scope theme registrable from any context.
    const assetRes = await app.request(
      "/plugin/assets/route-theme-plugin/route-theme-plugin-generation/themes/skin.json",
    )
    expect(assetRes.status).toBe(200)
    expect(assetRes.headers.get("content-type")).toBe("application/json")
    const asset = (await assetRes.json()) as { id: string }
    expect(asset.id).toBe("unused")

    // The catalog fallback serves only the manifest's declared ui.theme
    // assets: any other file in the plugin directory (e.g. manifests, env
    // files, source) must not be readable through the scope-less route.
    const undeclared = await app.request("/plugin/assets/route-theme-plugin/route-theme-plugin-generation/plugin.json")
    expect(undeclared.status).toBe(404)

    // No directory/scopeID on the request: the route must resolve as global,
    // not 400 ScopeRequired, and still surface the project-scope plugin.
    const res = await app.request("/plugin/ui/contributions/themes")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    const entry = body.find((item) => item.pluginId === "route-theme-plugin")
    expect(entry).toBeDefined()
    expect(entry).toMatchObject({
      generation: "route-theme-plugin-generation",
      contributions: [{ kind: "ui.theme", id: "skin", path: "themes/skin.json" }],
    })
    expect(Array.isArray(entry?.enabledScopes)).toBe(true)
    expect((entry?.enabledScopes as string[]).length).toBeGreaterThan(0)
    expect(entry?.scopeId).toBeUndefined()

    // A home-scope request must observe the same global list (no scope swap).
    const homeRes = await app.request("/plugin/ui/contributions/themes")
    expect(homeRes.status).toBe(200)
    const homeBody = (await homeRes.json()) as Array<Record<string, unknown>>
    expect(homeBody.some((item) => item.pluginId === "route-theme-plugin")).toBe(true)
  })

  test("rejects theme listings and assets after all scopes are disposed", async () => {
    await resetAllPluginState()
    const res = await app.request("/plugin/ui/contributions/themes")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])

    // Loader disposal removes the enabled scope but caches the catalog entry;
    // the global asset fallback must not keep serving the disposed plugin.
    const asset = await app.request("/plugin/assets/route-theme-plugin/route-theme-plugin-generation/themes/skin.json")
    expect(asset.status).toBe(404)
  })
})
