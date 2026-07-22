import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MCP } from "../../src/mcp"
import { McpSupervisor } from "../../src/mcp/supervisor"
import { startForPlugin } from "../../src/plugin/mcp"
import { ScopeContext } from "../../src/scope/context"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe.serial("MCP server resolver", () => {
  beforeEach(async () => {
    await McpSupervisor.reset()
  })

  afterEach(async () => {
    await McpSupervisor.reset()
  })

  test("resolves normalized config and exact namespaced plugin servers", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          configured: {
            type: "remote",
            url: "https://config.example.com/mcp",
            timeout: 1234,
          },
          disabled: { enabled: false },
          "demo-plugin::shadowed": {
            type: "remote",
            url: "https://configured-shadow.example.com/mcp",
            startup: "manual",
          },
        },
        mcpDefaults: {
          startup: "manual",
          required: true,
        },
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          remote: {
            type: "remote",
            url: "https://plugin.example.com/mcp",
            oauth: { scope: "mcp:connect" },
            startup: "manual",
            callTimeout: 2468,
          },
          shadowed: {
            type: "remote",
            url: "https://plugin-shadow.example.com/mcp",
            startup: "manual",
          },
        })

        expect(await MCP.resolveServer("configured")).toMatchObject({
          name: "configured",
          source: "config",
          config: {
            type: "remote",
            url: "https://config.example.com/mcp",
            startup: "manual",
            required: true,
            connectTimeout: 1234,
            listTimeout: 1234,
            callTimeout: 1234,
          },
        })
        expect(await MCP.resolveServer("demo-plugin::remote")).toMatchObject({
          name: "demo-plugin::remote",
          source: "plugin",
          config: {
            type: "remote",
            url: "https://plugin.example.com/mcp",
            startup: "manual",
            callTimeout: 2468,
          },
        })
        expect(await MCP.resolveServer("demo-plugin::shadowed")).toMatchObject({
          source: "config",
          config: { url: "https://configured-shadow.example.com/mcp" },
        })
        expect(await MCP.resolveServer("remote")).toBeUndefined()
        expect(await MCP.resolveServer("disabled")).toBeUndefined()
        expect(await MCP.resolveServer("missing")).toBeUndefined()
      },
    })
  })

  test("lists config and plugin servers once with source and status", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          configured: {
            type: "local",
            command: ["node", "configured.js"],
            startup: "manual",
          },
          disabled: { enabled: false },
        },
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          remote: {
            type: "remote",
            url: "https://plugin.example.com/mcp",
            startup: "manual",
          },
        })

        const servers = await MCP.listServers()
        expect(servers.map((server) => server.name).sort()).toEqual(["configured", "demo-plugin::remote"])
        expect(servers.find((server) => server.name === "configured")).toMatchObject({
          source: "config",
          status: { status: "uninitialized" },
        })
        expect(servers.find((server) => server.name === "demo-plugin::remote")).toMatchObject({
          source: "plugin",
          status: { status: "uninitialized" },
        })
      },
    })
  })

  test("detects OAuth support for plugin servers without config aliases", async () => {
    await using tmp = await tmpdir({ config: {} })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          oauth: {
            type: "remote",
            url: "https://plugin.example.com/oauth-mcp",
            oauth: { scope: "mcp:connect" },
            startup: "manual",
          },
          public: {
            type: "remote",
            url: "https://plugin.example.com/public-mcp",
            oauth: false,
            startup: "manual",
          },
        })

        expect(await MCP.supportsOAuth("demo-plugin::oauth")).toBe(true)
        expect(await MCP.supportsOAuth("demo-plugin::public")).toBe(false)
        expect(await MCP.supportsOAuth("oauth")).toBe(false)
      },
    })
  })
})
