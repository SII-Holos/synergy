import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject, validatePluginProject } from "@ericsanchezok/synergy-plugin-kit/commands"
import { Global } from "../../src/global"
import { MCP } from "../../src/mcp"
import { McpAuth } from "../../src/mcp/auth"
import { PendingOAuth } from "../../src/mcp/pending-oauth"
import { McpSupervisor } from "../../src/mcp/supervisor"
import { Plugin } from "../../src/plugin"
import { resolvePluginSpec } from "../../src/plugin/spec-resolver"
import { McpRoute } from "../../src/server/mcp-route"
import { ScopeContext } from "../../src/scope/context"
import { createOAuthMcpServerFixture } from "../fixture/oauth-mcp-server"
import { tmpdir } from "../fixture/fixture"

const PLUGIN_ID = "plugin-id"
const SERVER_NAME = `${PLUGIN_ID}::figma`
const MCP_TOOL_ID = "mcp__plugin-id__figma__fixture_ping"

let originalOAuthCallbackPort: string | undefined

async function reserveCallbackPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  })
  if (server.port === undefined) {
    server.stop(true)
    throw new Error("Failed to reserve OAuth callback port")
  }
  const port = server.port
  server.stop(true)
  return port
}

async function route(pathname: string, init: RequestInit = {}): Promise<Response> {
  return McpRoute.request(pathname, {
    ...init,
    headers: { origin: "http://127.0.0.1", ...init.headers },
  })
}

beforeAll(async () => {
  originalOAuthCallbackPort = process.env.SYNERGY_OAUTH_CALLBACK_PORT
  process.env.SYNERGY_OAUTH_CALLBACK_PORT = String(await reserveCallbackPort())
})

afterAll(() => {
  if (originalOAuthCallbackPort === undefined) delete process.env.SYNERGY_OAUTH_CALLBACK_PORT
  else process.env.SYNERGY_OAUTH_CALLBACK_PORT = originalOAuthCallbackPort
})

describe.serial("declarative plugin OAuth MCP integration", () => {
  test("installs, authenticates, discovers, and atomically uninstalls a runtime-free MCP contribution", async () => {
    await using tmp = await tmpdir({ config: {} })
    await using fixture = createOAuthMcpServerFixture()
    const pluginDir = path.join(tmp.path, "plugin")
    await fs.mkdir(path.join(pluginDir, "src"), { recursive: true })
    await fs.mkdir(path.join(pluginDir, "node_modules", "@ericsanchezok"), { recursive: true })
    await fs.symlink(
      path.resolve(import.meta.dir, "../../../plugin"),
      path.join(pluginDir, "node_modules", "@ericsanchezok", "synergy-plugin"),
      "dir",
    )
    await Bun.write(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", type: "module", source: "./src/index.ts" }),
    )
    await Bun.write(
      path.join(pluginDir, "src", "index.ts"),
      `import { definePlugin, mcp, settings } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "${PLUGIN_ID}",
  version: "1.0.0",
  description: "Declarative remote MCP fixture",
  capabilities: [],
  contributions: [
    mcp({
      id: "figma",
      enabledWhen: { setting: "figmaEnabled", equals: true },
      server: {
        type: "remote",
        url: ${JSON.stringify(fixture.url)},
        oauth: { scope: ${JSON.stringify(fixture.scope)} },
        startup: "eager",
      },
    }),
    settings({
      id: "settings",
      label: "Figma",
      group: "plugins",
      formSchema: {
        type: "object",
        properties: { figmaEnabled: { type: "boolean", default: true } },
        additionalProperties: false,
      },
    }),
  ],
})
`,
    )

    expect(await buildPluginProject(pluginDir)).toBe(true)
    const validation = await validatePluginProject(pluginDir)
    expect(validation.filter((entry) => entry.type === "error")).toEqual([])
    const builtManifest = PluginManifest.parse(await Bun.file(path.join(pluginDir, "dist", "plugin.json")).json())
    expect(builtManifest.artifacts.runtime).toBeUndefined()
    expect(await Bun.file(path.join(pluginDir, "dist", "runtime", "index.js")).exists()).toBe(false)

    const authFile = Bun.file(Global.Path.authMcp)
    const authBackup = (await authFile.exists()) ? await authFile.text() : undefined
    await fs.mkdir(path.dirname(Global.Path.authMcp), { recursive: true })
    await Bun.write(Global.Path.authMcp, "{}")
    McpAuth.invalidateCache()

    let installed = false
    let uninstalled = false
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const sourceSpec = pathToFileURL(pluginDir).href
          const plugin = await Plugin.add(sourceSpec, { source: "local", skipConsent: true })
          installed = true

          expect(plugin.id).toBe(PLUGIN_ID)
          expect(plugin.source).toBe("local")
          expect(plugin.entryPath).toBeUndefined()
          expect(plugin.manifest.artifacts.runtime).toBeUndefined()
          const resolvedArtifact = await resolvePluginSpec(sourceSpec, { install: false })
          expect(resolvedArtifact.entryPath).toBeUndefined()

          const handle = McpSupervisor.get(SERVER_NAME)
          expect(handle).toBeDefined()
          expect(handle!.source).toBe("plugin")
          expect(handle!.pluginId).toBe(PLUGIN_ID)
          expect(McpSupervisor.get("figma")).toBeUndefined()
          expect(await MCP.resolveServer("figma")).toBeUndefined()
          expect(await MCP.resolveServer(SERVER_NAME)).toEqual(
            expect.objectContaining({ name: SERVER_NAME, source: "plugin", identity: handle!.identity }),
          )
          expect((await MCP.listServers()).map((server) => server.name)).toContain(SERVER_NAME)
          expect((await MCP.status())[SERVER_NAME]).toBeDefined()

          await handle!.startPromise
          expect((await MCP.status())[SERVER_NAME]).toEqual({ status: "needs_auth" })
          expect(PendingOAuth.get(SERVER_NAME)?.identity).toBe(handle!.identity)

          const registration = fixture.snapshot().registrations.at(-1)
          expect(registration).toEqual(
            expect.objectContaining({
              clientId: "fixture-client",
              redirectUris: [expect.stringContaining("/mcp/oauth/callback")],
              scope: fixture.scope,
              tokenEndpointAuthMethod: "none",
            }),
          )

          const authStart = await route(`/${encodeURIComponent(SERVER_NAME)}/auth`, { method: "POST" })
          expect(authStart.status).toBe(200)
          const { authorizationUrl } = (await authStart.json()) as { authorizationUrl: string }
          const authorization = await fixture.followAuthorization(authorizationUrl)
          const authorizationObservation = fixture.snapshot().authorizations.at(-1)
          expect(authorizationObservation).toEqual(
            expect.objectContaining({
              scope: fixture.scope,
              state: authorization.state,
              resource: fixture.url,
              codeChallengeMethod: "S256",
            }),
          )
          expect(authorizationObservation?.codeChallenge).not.toBe("")

          const callback = await route(`/${encodeURIComponent(SERVER_NAME)}/auth/callback`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: authorization.code }),
          })
          expect(callback.status).toBe(200)
          expect(await callback.json()).toEqual({ status: "connected" })
          expect(McpSupervisor.get(SERVER_NAME)).toBe(handle)
          expect(McpSupervisor.get(SERVER_NAME)?.identity).toBe(handle!.identity)
          expect(PendingOAuth.get(SERVER_NAME)).toBeUndefined()

          const tokenExchange = fixture.snapshot().tokenExchanges.at(-1)
          expect(tokenExchange).toEqual(
            expect.objectContaining({
              clientId: "fixture-client",
              code: authorization.code,
              resource: fixture.url,
            }),
          )
          expect(tokenExchange?.codeVerifier).not.toBe("")
          const authState = await McpAuth.all()
          expect(Object.keys(authState)).toEqual([SERVER_NAME])
          expect(authState["figma"]).toBeUndefined()
          expect(authState[SERVER_NAME]?.tokens?.scope).toBe(fixture.scope)
          expect(authState[SERVER_NAME]?.codeVerifier).toBeUndefined()
          expect(authState[SERVER_NAME]?.oauthState).toBeUndefined()

          await MCP.refresh(SERVER_NAME)
          const inspection = await MCP.inspect(SERVER_NAME)
          expect(inspection?.toolNames).toContain(fixture.toolName)
          expect(inspection?.resourceNames).toContain(fixture.resourceName)
          const toolEntries = await MCP.toolEntries()
          expect(toolEntries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: MCP_TOOL_ID,
                serverName: SERVER_NAME,
                toolName: fixture.toolName,
              }),
            ]),
          )
          expect((await MCP.tools())[MCP_TOOL_ID]).toBeDefined()
          const resources = await MCP.resources()
          expect(Object.values(resources)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: fixture.resourceName,
                uri: fixture.resourceUri,
                client: SERVER_NAME,
              }),
            ]),
          )
          expect(await MCP.readResource(SERVER_NAME, fixture.resourceUri)).toEqual({
            contents: [
              {
                uri: fixture.resourceUri,
                mimeType: "application/json",
                text: '{"fixture":true}',
              },
            ],
          })

          await Plugin.updateConfig(plugin, { figmaEnabled: false })
          expect(McpSupervisor.get(SERVER_NAME)).toBeUndefined()
          expect(await MCP.resolveServer(SERVER_NAME)).toBeUndefined()

          await Plugin.updateConfig(plugin, { figmaEnabled: true })
          const restored = McpSupervisor.get(SERVER_NAME)
          expect(restored).toBeDefined()
          expect(restored?.config.startup).toBe("eager")
          await restored?.startPromise
          expect((await MCP.status())[SERVER_NAME]).toEqual({ status: "connected" })

          const removeAuth = await route(`/${encodeURIComponent(SERVER_NAME)}/auth`, { method: "DELETE" })
          expect(removeAuth.status).toBe(200)
          expect(await McpAuth.get(SERVER_NAME)).toBeUndefined()
          const secondStart = await route(`/${encodeURIComponent(SERVER_NAME)}/auth`, { method: "POST" })
          expect(secondStart.status).toBe(200)
          const secondAuthorizationUrl = ((await secondStart.json()) as { authorizationUrl: string }).authorizationUrl
          expect(secondAuthorizationUrl).not.toBe("")
          expect(PendingOAuth.get(SERVER_NAME)?.identity).toBe(restored!.identity)
          expect((await McpAuth.get(SERVER_NAME))?.codeVerifier).toBeDefined()
          expect((await McpAuth.get(SERVER_NAME))?.oauthState).toBeDefined()

          await Plugin.remove(PLUGIN_ID)
          installed = false
          uninstalled = true
          expect(McpSupervisor.get(SERVER_NAME)).toBeUndefined()
          expect(PendingOAuth.get(SERVER_NAME)).toBeUndefined()
          expect(await MCP.resolveServer(SERVER_NAME)).toBeUndefined()
          expect((await MCP.listServers()).some((server) => server.name === SERVER_NAME)).toBe(false)
          expect((await MCP.status())[SERVER_NAME]).toBeUndefined()
          expect((await McpAuth.get(SERVER_NAME))?.codeVerifier).toBeUndefined()
          expect((await McpAuth.get(SERVER_NAME))?.oauthState).toBeUndefined()
        },
      })
      expect(uninstalled).toBe(true)
    } finally {
      if (installed) {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            await Plugin.remove(PLUGIN_ID, { force: true }).catch(() => undefined)
          },
        })
      }
      await MCP.stop()
      await PendingOAuth.disposeAll("declarative plugin OAuth test cleanup")
      if (authBackup === undefined) await Bun.write(Global.Path.authMcp, "{}")
      else await Bun.write(Global.Path.authMcp, authBackup)
      McpAuth.invalidateCache()
    }
  })
})
