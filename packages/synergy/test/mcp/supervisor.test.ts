import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { connectClientOrCloseOnFailure, McpSupervisor, probeClientConnection } from "../../src/mcp/supervisor"
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

  test("closes an MCP client after probing succeeds or fails", async () => {
    for (const failure of [undefined, new Error("connect failed")]) {
      let closed = false
      const client = {
        connect: async () => {
          if (failure) throw failure
        },
        close: async () => {
          closed = true
        },
      }

      const result = probeClientConnection(client, undefined as never, "probe")
      if (failure) await expect(result).rejects.toThrow("connect failed")
      else await result
      expect(closed).toBe(true)
    }
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
          identity: McpSupervisor.get("auth-server")!.identity,
        })

        await McpSupervisor.disconnect("auth-server")

        expect(closed).toBe(true)
      },
    })
  })

  test("remove waits for disposal and publishes the final tools change", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const events: string[] = []
        const unsubscribe = Bus.subscribe(MCP.ToolsChanged, (event) => events.push(event.properties.server))
        McpSupervisor.add("removed-server", {
          type: "remote",
          url: "https://example.com/mcp",
          startup: "manual",
        })

        await McpSupervisor.remove("removed-server")
        unsubscribe()

        expect(McpSupervisor.get("removed-server")).toBeUndefined()
        expect(events).toEqual(["removed-server"])
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
            callTimeout: 2468,
          },
        })

        expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")

        await MCP.connect("demo-plugin::layout")

        expect((await MCP.status())["demo-plugin::layout"].status).toBe("connected")
        const entries = await MCP.toolEntries()
        const entry = entries.find((item) => item.id === "mcp__demo-plugin__layout__demo_tool")
        expect(entry).toBeDefined()
        expect(Object.getOwnPropertySymbols(entry!.inputSchema)).toEqual([])
        expect(Object.getOwnPropertySymbols(entry!.tool.inputSchema)).not.toEqual([])
        expect(MCP.toolCallTimeout("mcp__demo-plugin__layout__demo_tool")).toBe(2468)
        expect(McpSupervisor.get("demo-plugin::layout")?.localProcess).toMatchObject({
          stdioState: "open",
          closeTimeoutMs: 5_000,
          descendantPipeGraceMs: 2_000,
        })
        expect(McpSupervisor.resourceStats()).toMatchObject({
          processCount: 1,
          measuredProcessCount: 1,
          stdio: { open: 1, closing: 0, timedOut: 0 },
        })
        await MCP.disconnect("demo-plugin::layout")
        expect(McpSupervisor.resourceStats()).toMatchObject({
          processCount: 0,
          stdio: { open: 0, closing: 0, closed: 1, timedOut: 0 },
          lastRecovery: {
            action: "close",
            timedOut: false,
          },
        })
      },
    })
  })

  test("plugin lifecycle init and reload wait for MCP contributions to stabilize", async () => {
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
        expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")

        await Plugin.reload()
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

  test("replaces a plugin MCP handle set exactly", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          old: {
            type: "local",
            command: ["node", "old-server.js"],
            startup: "manual",
          },
          stable: {
            type: "local",
            command: ["node", "stable-v1.js"],
            startup: "manual",
          },
        })

        await startForPlugin("demo-plugin", {
          stable: {
            type: "local",
            command: ["node", "stable-v2.js"],
            startup: "manual",
          },
          fresh: {
            type: "local",
            command: ["node", "fresh-server.js"],
            startup: "manual",
          },
        })

        expect(McpSupervisor.get("demo-plugin::old")).toBeUndefined()
        expect(McpSupervisor.get("demo-plugin::stable")?.config).toMatchObject({
          command: ["node", "stable-v2.js"],
        })
        expect(McpSupervisor.get("demo-plugin::fresh")?.config).toMatchObject({
          command: ["node", "fresh-server.js"],
        })
        expect(
          McpSupervisor.getAll()
            .map((handle) => handle.name)
            .filter((name) => name.startsWith("demo-plugin::"))
            .sort(),
        ).toEqual(["demo-plugin::fresh", "demo-plugin::stable"])
      },
    })
  })

  test("preserves the previous plugin MCP handle set when replacement validation fails", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          stable: {
            type: "local",
            command: ["node", "stable-v1.js"],
            startup: "manual",
          },
          retained: {
            type: "local",
            command: ["node", "retained.js"],
            startup: "manual",
          },
        })

        await expect(
          startForPlugin("demo-plugin", {
            stable: {
              type: "local",
              command: ["node", "stable-v2.js"],
              startup: "manual",
            },
            fresh: {
              type: "local",
              command: ["node", "fresh-server.js"],
              startup: "manual",
            },
            broken: {
              type: "remote",
              url: "file:///tmp/mcp.sock",
              startup: "manual",
            },
          }),
        ).rejects.toMatchObject({
          name: "MCPInvalidPluginServer",
          data: { pluginId: "demo-plugin", contributionId: "broken" },
        })

        expect(McpSupervisor.get("demo-plugin::stable")?.config).toMatchObject({
          command: ["node", "stable-v1.js"],
        })
        expect(McpSupervisor.get("demo-plugin::retained")?.config).toMatchObject({
          command: ["node", "retained.js"],
        })
        expect(McpSupervisor.get("demo-plugin::fresh")).toBeUndefined()
        expect(McpSupervisor.get("demo-plugin::broken")).toBeUndefined()
      },
    })
  })
  test("validates every plugin candidate before replacing any plugin handles", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("plugin-a", {
          stable: {
            type: "local",
            command: ["node", "a-v1.js"],
            startup: "manual",
          },
        })
        await startForPlugin("plugin-b", {
          stable: {
            type: "local",
            command: ["node", "b-v1.js"],
            startup: "manual",
          },
        })

        const events: string[] = []
        const unsubscribe = Bus.subscribe(MCP.ToolsChanged, (event) => events.push(event.properties.server))
        const adapter = await import("../../src/plugin/mcp")
        await expect(
          adapter.replaceForPlugins([
            {
              pluginId: "plugin-a",
              declarations: {
                stable: {
                  type: "local",
                  command: ["node", "a-v2.js"],
                  startup: "manual",
                },
                fresh: {
                  type: "local",
                  command: ["node", "a-fresh.js"],
                  startup: "manual",
                },
              },
            },
            {
              pluginId: "plugin-b",
              declarations: {
                broken: {
                  type: "remote",
                  url: "file:///tmp/plugin-b.sock",
                  startup: "manual",
                },
              },
            },
          ]),
        ).rejects.toMatchObject({
          name: "MCPInvalidPluginServer",
          data: { pluginId: "plugin-b", contributionId: "broken" },
        })
        unsubscribe()

        expect(McpSupervisor.get("plugin-a::stable")?.config).toMatchObject({ command: ["node", "a-v1.js"] })
        expect(McpSupervisor.get("plugin-a::fresh")).toBeUndefined()
        expect(McpSupervisor.get("plugin-b::stable")?.config).toMatchObject({ command: ["node", "b-v1.js"] })
        expect(McpSupervisor.get("plugin-b::broken")).toBeUndefined()
        expect(events).toEqual([])
      },
    })
  })
})
