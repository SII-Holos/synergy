import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { connectClientOrCloseOnFailure, McpSupervisor } from "../../src/mcp/supervisor"
import { PendingOAuth } from "../../src/mcp/pending-oauth"
import { Plugin } from "../../src/plugin"
import { computeManifestHash, computePermissionsHash, saveApproval } from "../../src/plugin/consent/approval-store"
import { startForPlugin } from "../../src/plugin/mcp"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function writeFakeMcpServer(dir: string) {
  const serverPath = path.join(dir, "fake-mcp-server.mjs")
  const sdkRoot = path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm")
  const mcpModule = pathToFileURL(path.join(sdkRoot, "server", "mcp.js")).href
  const stdioModule = pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href
  await Bun.write(
    serverPath,
    `
import { McpServer } from ${JSON.stringify(mcpModule)}
import { StdioServerTransport } from ${JSON.stringify(stdioModule)}

const server = new McpServer({ name: "fake-mcp", version: "0.0.0" })
server.tool("demo_tool", "Demo MCP tool", {}, async () => ({
  content: [{ type: "text", text: "ok" }],
}))

await server.connect(new StdioServerTransport())
`,
  )
  return serverPath
}

async function writeMcpPlugin(root: string, input: { id: string; serverPath: string }) {
  const dir = path.join(root, input.id)
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    manifestVersion: 1 as const,
    apiVersion: "3.0" as const,
    id: input.id,
    name: input.id,
    version: "0.1.0",
    description: "MCP contribution test plugin",
    capabilities: [],
    contributions: [
      {
        kind: "mcp" as const,
        id: "layout",
        server: {
          type: "local",
          command: ["node", input.serverPath],
          startup: "lazy",
        },
      },
    ],
    artifacts: { generation: "mcp-test-generation" },
  } satisfies PluginManifestType
  await Bun.write(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

describe.serial("McpSupervisor", () => {
  beforeEach(async () => {
    await McpSupervisor.reset()
  })

  afterEach(async () => {
    await McpSupervisor.reset()
  })

  test("reports disabled and manual servers without starting them", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          disabled: {
            type: "local",
            command: ["node", "server.js"],
            enabled: false,
          },
          manual: {
            type: "local",
            command: ["node", "server.js"],
            startup: "manual",
          },
          lazy: {
            type: "remote",
            url: "https://example.com/mcp",
            startup: "lazy",
          },
        },
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const status = await MCP.status()
        expect(status.disabled.status).toBe("disabled")
        expect(status.manual.status).toBe("uninitialized")
        expect(status.lazy.status).toBe("uninitialized")
      },
    })
  })

  test("returns MCP tools as a non-blocking snapshot", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          manual: {
            type: "local",
            command: ["node", "server.js"],
            startup: "manual",
          },
        },
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tools = await MCP.tools()
        expect(tools).toEqual({})
      },
    })
  })

  test("closes MCP client when startup connect fails", async () => {
    let closed = false
    const client = {
      connect: async () => {
        throw new Error("connect failed")
      },
      close: async () => {
        closed = true
      },
    }

    await expect(
      connectClientOrCloseOnFailure(client, undefined as never, undefined, "invalid", "connect:stdio"),
    ).rejects.toThrow("connect failed")
    expect(closed).toBe(true)
  })

  test("disconnect releases a pending OAuth owner", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        let closed = false
        McpSupervisor.add("auth-server", {
          type: "remote",
          url: "https://example.com/mcp",
          startup: "manual",
        })
        await PendingOAuth.register("auth-server", {
          client: {
            close: async () => {
              closed = true
            },
          },
          transport: { finishAuth: async () => {} },
        })

        await McpSupervisor.disconnect("auth-server")

        expect(closed).toBe(true)
      },
    })
  })

  test("registers plugin MCP servers with defaults and skips metadata", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const events: string[] = []
        const unsubscribe = Bus.subscribe(MCP.ToolsChanged, (event) => events.push(event.properties.server))
        await startForPlugin("demo-plugin", {
          defaults: { startup: "manual", listTimeout: 1234 },
          locked: true,
          layout: {
            type: "local",
            command: ["node", "layout-server.js"],
          },
        })
        unsubscribe()

        const status = await MCP.status()
        expect(status["demo-plugin::layout"].status).toBe("uninitialized")
        expect(events).toEqual(["demo-plugin::layout"])
        expect(status["demo-plugin::defaults"]).toBeUndefined()
        expect(status["demo-plugin::locked"]).toBeUndefined()

        const handle = McpSupervisor.get("demo-plugin::layout")
        expect(handle?.config.startup).toBe("manual")
        expect(handle?.config.listTimeout).toBe(1234)
      },
    })
  })

  test("connects lazy plugin MCP handles and exposes their tools", async () => {
    await using tmp = await tmpdir({ config: {} })
    const serverPath = await writeFakeMcpServer(tmp.path)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          defaults: { startup: "lazy" },
          layout: {
            type: "local",
            command: ["node", serverPath],
          },
        })

        expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")

        await MCP.connect("demo-plugin::layout")

        expect((await MCP.status())["demo-plugin::layout"].status).toBe("connected")
        const entries = await MCP.toolEntries()
        expect(entries.map((entry) => entry.id)).toContain("mcp__demo-plugin__layout__demo_tool")
      },
    })
  })

  test("plugin MCP contributions can be re-registered after MCP reload", async () => {
    await using tmp = await tmpdir<{ pluginDir: string; manifest: PluginManifestType }>({
      git: true,
      init: async (dir) => {
        const serverPath = await writeFakeMcpServer(dir)
        const plugin = await writeMcpPlugin(dir, { id: "demo-plugin", serverPath })
        return { pluginDir: plugin.dir, manifest: plugin.manifest }
      },
      config: {
        pluginMarketplace: { enabled: false },
        pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
      } as any,
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await saveApproval({
          pluginId: tmp.extra.manifest.id,
          source: "local",
          version: tmp.extra.manifest.version,
          manifestHash: computeManifestHash(tmp.extra.manifest),
          capabilitiesHash: computePermissionsHash(tmp.extra.manifest),
          approvedAt: Date.now(),
          approvedBy: "user",
          trustTier: "declarative",
          approvedCapabilities: [],
          risk: "low",
          status: "approved",
        })
        await Config.update({
          plugin: [pathToFileURL(tmp.extra.pluginDir).href],
        } as any)
        await Plugin.init()
        await Plugin.reloadMcpContributions()
        expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")

        await MCP.reload()
        expect((await MCP.status())["demo-plugin::layout"]).toBeUndefined()

        await Plugin.reloadMcpContributions()
        expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")
      },
    })
  })

  test("does not register plugin MCP when user config shadows the bare key", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          layout: {
            type: "local",
            command: ["node", "user-server.js"],
            startup: "manual",
          },
        },
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          defaults: { startup: "manual" },
          layout: {
            type: "local",
            command: ["node", "plugin-server.js"],
          },
        })

        const status = await MCP.status()
        expect(status.layout.status).toBe("uninitialized")
        expect(status["demo-plugin::layout"]).toBeUndefined()
      },
    })
  })

  test("normalizes plugin MCP declarations with user mcpDefaults", async () => {
    await using tmp = await tmpdir({
      config: {
        mcpDefaults: {
          startup: "manual",
          callTimeout: 4321,
        },
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.current()
        expect(config.mcpDefaults?.callTimeout).toBe(4321)

        await startForPlugin("demo-plugin", {
          toolbelt: {
            type: "remote",
            url: "https://example.com/mcp",
          },
        })

        const handle = McpSupervisor.get("demo-plugin::toolbelt")
        expect(handle?.config.startup).toBe("manual")
        expect(handle?.config.callTimeout).toBe(4321)
      },
    })
  })
})
