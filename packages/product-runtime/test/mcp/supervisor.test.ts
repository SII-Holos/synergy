import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { MCP } from "@ericsanchezok/synergy-agent-integrations/mcp"
import {
  connectClientOrCloseOnFailure,
  McpSupervisor,
  probeClientConnection,
} from "@ericsanchezok/synergy-agent-integrations/mcp/supervisor"
import { PendingOAuth } from "@ericsanchezok/synergy-agent-integrations/mcp/pending-oauth"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { createApprovalRecord, saveApproval } from "@ericsanchezok/synergy-plugin-host/plugin/consent/approval-store"
import { startForPlugin } from "@ericsanchezok/synergy-plugin-host/plugin/mcp"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

async function writeFakeMcpServer(dir: string) {
  const serverPath = path.join(dir, "fake-mcp-server.mjs")
  const mcpModule = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js")
  const stdioModule = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js")
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
    apiVersion: "4.0" as const,
    compatibility: { synergy: ">=3.0.11" },
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

async function startRemoteMcpFixture() {
  let healthy = false
  let requests = 0
  const servers = new Set<McpServer>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++
      if (!healthy) return new Response("upstream unavailable", { status: 503 })
      const mcp = new McpServer({ name: "remote-fixture", version: "1.0.0" })
      mcp.registerTool("remote_ping", { description: "Remote fixture ping" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }))
      servers.add(mcp)
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      await mcp.connect(transport)
      return transport.handleRequest(request)
    },
  })
  if (server.port === undefined) throw new Error("Failed to allocate remote MCP fixture port")
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests: () => requests,
    setHealthy: (value: boolean) => {
      healthy = value
    },
    async [Symbol.asyncDispose]() {
      await Promise.all([...servers].map((mcp) => mcp.close().catch(() => undefined)))
      servers.clear()
      server.stop(true)
    },
  }
}

async function waitForStatus(name: string, expected: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await MCP.status())[name]?.status === expected) return
    await Bun.sleep(25)
  }
  throw new Error(`MCP ${name} did not reach ${expected}; last=${JSON.stringify((await MCP.status())[name])}`)
}

describe.serial("McpSupervisor", () => {
  beforeEach(() =>
    runtime.run(async () => {
      await McpSupervisor().reset()
    }),
  )

  afterEach(() =>
    runtime.run(async () => {
      await McpSupervisor().reset()
    }),
  )

  test("reports disabled and manual servers without starting them", () =>
    runtime.run(async () => {
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
    }))

  test("returns MCP tools as a non-blocking snapshot", () =>
    runtime.run(async () => {
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
    }))

  test("closes MCP client when startup connect fails", () =>
    runtime.run(async () => {
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
    }))

  test("closes an MCP client after probing succeeds or fails", () =>
    runtime.run(async () => {
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
    }))

  test("disconnect releases a pending OAuth owner", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          let closed = false
          McpSupervisor().add("auth-server", {
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
            identity: McpSupervisor().get("auth-server")!.identity,
          })

          await McpSupervisor().disconnect("auth-server")

          expect(closed).toBe(true)
        },
      })
    }))

  test("remove waits for disposal and publishes the final tools change", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const events: string[] = []
          const unsubscribe = Bus.subscribe(MCP.ToolsChanged, (event) => events.push(event.properties.server))
          McpSupervisor().add("removed-server", {
            type: "remote",
            url: "https://example.com/mcp",
            startup: "manual",
          })

          await McpSupervisor().remove("removed-server")
          unsubscribe()

          expect(McpSupervisor().get("removed-server")).toBeUndefined()
          expect(events).toEqual(["removed-server"])
        },
      })
    }))

  test("registers plugin MCP servers with defaults and skips metadata", () =>
    runtime.run(async () => {
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

          const handle = McpSupervisor().get("demo-plugin::layout")
          expect(handle?.config.startup).toBe("manual")
          expect(handle?.config.listTimeout).toBe(1234)
        },
      })
    }))

  test("connects lazy plugin MCP handles and exposes their tools", () =>
    runtime.run(async () => {
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
          expect(McpSupervisor().get("demo-plugin::layout")?.localProcess).toMatchObject({
            stdioState: "open",
            closeTimeoutMs: 5_000,
            descendantPipeGraceMs: 2_000,
          })
          expect(McpSupervisor().resourceStats()).toMatchObject({
            processCount: 1,
            measuredProcessCount: 1,
            stdio: { open: 1, closing: 0, timedOut: 0 },
          })
          await MCP.disconnect("demo-plugin::layout")
          expect(McpSupervisor().resourceStats()).toMatchObject({
            processCount: 0,
            stdio: { open: 0, closing: 0, closed: 1, timedOut: 0 },
            lastRecovery: {
              action: "close",
              timedOut: false,
            },
          })
        },
      })
    }))

  test("plugin lifecycle init and reload wait for MCP contributions to stabilize", () =>
    runtime.run(async () => {
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
          await saveApproval(
            createApprovalRecord({
              pluginId: tmp.extra.manifest.id,
              source: "local",
              manifest: tmp.extra.manifest,
            }),
          )
          await Config.update({
            plugin: [pathToFileURL(tmp.extra.pluginDir).href],
          } as any)

          await Plugin.init()
          expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")

          await Plugin.reload()
          expect((await MCP.status())["demo-plugin::layout"].status).toBe("uninitialized")
        },
      })
    }))

  test("does not register plugin MCP when user config shadows the bare key", () =>
    runtime.run(async () => {
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
    }))

  test("normalizes plugin MCP declarations with user mcpDefaults", () =>
    runtime.run(async () => {
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

          const handle = McpSupervisor().get("demo-plugin::toolbelt")
          expect(handle?.config.startup).toBe("manual")
          expect(handle?.config.callTimeout).toBe(4321)
        },
      })
    }))

  test("replaces a plugin MCP handle set exactly", () =>
    runtime.run(async () => {
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

          expect(McpSupervisor().get("demo-plugin::old")).toBeUndefined()
          expect(McpSupervisor().get("demo-plugin::stable")?.config).toMatchObject({
            command: ["node", "stable-v2.js"],
          })
          expect(McpSupervisor().get("demo-plugin::fresh")?.config).toMatchObject({
            command: ["node", "fresh-server.js"],
          })
          expect(
            McpSupervisor()
              .getAll()
              .map((handle) => handle.name)
              .filter((name) => name.startsWith("demo-plugin::"))
              .sort(),
          ).toEqual(["demo-plugin::fresh", "demo-plugin::stable"])
        },
      })
    }))

  test("preserves the previous plugin MCP handle set when replacement validation fails", () =>
    runtime.run(async () => {
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

          expect(McpSupervisor().get("demo-plugin::stable")?.config).toMatchObject({
            command: ["node", "stable-v1.js"],
          })
          expect(McpSupervisor().get("demo-plugin::retained")?.config).toMatchObject({
            command: ["node", "retained.js"],
          })
          expect(McpSupervisor().get("demo-plugin::fresh")).toBeUndefined()
          expect(McpSupervisor().get("demo-plugin::broken")).toBeUndefined()
        },
      })
    }))
  test("validates every plugin candidate before replacing any plugin handles", () =>
    runtime.run(async () => {
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
          const adapter = await import("@ericsanchezok/synergy-plugin-host/plugin/mcp")
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

          expect(McpSupervisor().get("plugin-a::stable")?.config).toMatchObject({ command: ["node", "a-v1.js"] })
          expect(McpSupervisor().get("plugin-a::fresh")).toBeUndefined()
          expect(McpSupervisor().get("plugin-b::stable")?.config).toMatchObject({ command: ["node", "b-v1.js"] })
          expect(McpSupervisor().get("plugin-b::broken")).toBeUndefined()
          expect(events).toEqual([])
        },
      })
    }))
  test("reports the real transport failure cause instead of unknown error", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const failures: string[] = []
          const unsubscribe = Bus.subscribe(MCP.FailedEvent, (event) => failures.push(event.properties.error))
          const handle = McpSupervisor().add("flaky-remote", {
            type: "remote",
            url: fixture.url,
            startup: "manual",
            retry: { maxAttempts: 1 },
          })

          await McpSupervisor().connect("flaky-remote", handle.identity)
          unsubscribe()

          const status = (await MCP.status())["flaky-remote"]
          if (status.status !== "failed") throw new Error(`expected failed, got ${status.status}`)
          expect(status.error).toContain("upstream unavailable")
          expect(status.error).not.toBe("unknown error")
          expect(failures).toEqual([expect.stringContaining("upstream unavailable")])
        },
      })
    }))

  test("an eager server retries after the cooldown and recovers once the endpoint is healthy", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const handle = McpSupervisor().add("recovering-remote", {
            type: "remote",
            url: fixture.url,
            startup: "eager",
            requiresWorkspace: false,
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })

          await handle.startPromise
          expect((await MCP.status())["recovering-remote"]).toMatchObject({ status: "failed" })
          const attemptsBeforeRecovery = fixture.requests()

          fixture.setHealthy(true)
          await waitForStatus("recovering-remote", "connected")

          expect(fixture.requests()).toBeGreaterThan(attemptsBeforeRecovery)
          expect(await MCP.tools()).toHaveProperty("mcp__recovering-remote__remote_ping")
        },
      })
    }))

  test("manual servers stay failed without a retry cycle", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const handle = McpSupervisor().add("manual-remote", {
            type: "remote",
            url: fixture.url,
            startup: "manual",
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })

          await McpSupervisor().connect("manual-remote", handle.identity)
          expect((await MCP.status())["manual-remote"]).toMatchObject({ status: "failed" })
          const requestsAfterFailure = fixture.requests()

          await Bun.sleep(500)

          expect((await MCP.status())["manual-remote"]).toMatchObject({ status: "failed" })
          expect(fixture.requests()).toBe(requestsAfterFailure)
        },
      })
    }))

  test("disconnect cancels a pending failed retry", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const handle = McpSupervisor().add("disconnected-remote", {
            type: "remote",
            url: fixture.url,
            startup: "eager",
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })

          await handle.startPromise
          expect((await MCP.status())["disconnected-remote"]).toMatchObject({ status: "failed" })

          await McpSupervisor().disconnect("disconnected-remote")
          const requestsAfterDisconnect = fixture.requests()

          await Bun.sleep(500)

          expect((await MCP.status())["disconnected-remote"]).toMatchObject({ status: "disabled" })
          expect(fixture.requests()).toBe(requestsAfterDisconnect)
        },
      })
    }))
  test("lazy servers stay failed without a retry cycle", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const handle = McpSupervisor().add("lazy-remote", {
            type: "remote",
            url: fixture.url,
            startup: "lazy",
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })

          await McpSupervisor().connect("lazy-remote", handle.identity)
          expect((await MCP.status())["lazy-remote"]).toMatchObject({ status: "failed" })
          const requestsAfterFailure = fixture.requests()

          await Bun.sleep(500)

          expect((await MCP.status())["lazy-remote"]).toMatchObject({ status: "failed" })
          expect(fixture.requests()).toBe(requestsAfterFailure)
        },
      })
    }))

  test("an explicit reconnect of a failed server publishes mcp.failed again", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const failures: string[] = []
          const unsubscribe = Bus.subscribe(MCP.FailedEvent, (event) => failures.push(event.properties.error))
          const handle = McpSupervisor().add("refailed-remote", {
            type: "remote",
            url: fixture.url,
            startup: "manual",
            retry: { maxAttempts: 1 },
          })

          await McpSupervisor().connect("refailed-remote", handle.identity)
          expect(failures).toHaveLength(1)

          await McpSupervisor().connect("refailed-remote", handle.identity)
          unsubscribe()

          expect(failures).toHaveLength(2)
          expect((await MCP.status())["refailed-remote"]).toMatchObject({ status: "failed" })
        },
      })
    }))

  test("a failed transition publishes mcp.tools.changed once and cooldown retries stay silent", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const toolsChanged: string[] = []
          const unsubscribe = Bus.subscribe(MCP.ToolsChanged, (event) => toolsChanged.push(event.properties.server))
          const handle = McpSupervisor().add("tools-changed-remote", {
            type: "remote",
            url: fixture.url,
            startup: "eager",
            requiresWorkspace: false,
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })

          await handle.startPromise
          expect((await MCP.status())["tools-changed-remote"]).toMatchObject({ status: "failed" })

          await Bun.sleep(500)
          unsubscribe()

          expect(toolsChanged).toEqual(["tools-changed-remote"])
        },
      })
    }))

  test("cooldownMs of zero begins the next cycle immediately", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const handle = McpSupervisor().add("immediate-remote", {
            type: "remote",
            url: fixture.url,
            startup: "eager",
            requiresWorkspace: false,
            retry: { maxAttempts: 1, cooldownMs: 0 },
          })

          await handle.startPromise
          const requestsAfterFirstFailure = fixture.requests()

          const deadline = Date.now() + 1_000
          while (fixture.requests() === requestsAfterFirstFailure && Date.now() < deadline) await Bun.sleep(10)

          // The default cooldown is 60s, so a second attempt inside 1s proves zero starts the next cycle immediately.
          expect(fixture.requests()).toBeGreaterThan(requestsAfterFirstFailure)
        },
      })
    }))

  test("remove and reset leave no further connection attempts", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await using fixture = await startRemoteMcpFixture()

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const removed = McpSupervisor().add("removed-remote", {
            type: "remote",
            url: fixture.url,
            startup: "eager",
            requiresWorkspace: false,
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })
          const reset = McpSupervisor().add("reset-remote", {
            type: "remote",
            url: fixture.url,
            startup: "eager",
            requiresWorkspace: false,
            retry: { maxAttempts: 1, cooldownMs: 150 },
          })

          await Promise.all([removed.startPromise, reset.startPromise])
          expect((await MCP.status())["removed-remote"]).toMatchObject({ status: "failed" })
          expect((await MCP.status())["reset-remote"]).toMatchObject({ status: "failed" })

          await McpSupervisor().remove("removed-remote")
          expect(McpSupervisor().get("removed-remote")).toBeUndefined()
          await McpSupervisor().reset()
          const requestsAfterReset = fixture.requests()

          await Bun.sleep(500)

          expect(McpSupervisor().get("reset-remote")).toBeUndefined()
          expect(fixture.requests()).toBe(requestsAfterReset)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
