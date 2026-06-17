import { afterEach, describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { McpSupervisor } from "../../src/mcp/supervisor"
import { startForPlugin } from "../../src/plugin/mcp"
import { Instance } from "../../src/scope/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe.serial("McpSupervisor", () => {
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

    await Instance.provide({
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

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tools = await MCP.tools()
        expect(tools).toEqual({})
      },
    })
  })

  test("registers plugin MCP servers with defaults and skips metadata", async () => {
    await using tmp = await tmpdir({ config: {} })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await startForPlugin("demo-plugin", {
          defaults: { startup: "manual", listTimeout: 1234 },
          locked: true,
          layout: {
            type: "local",
            command: ["node", "layout-server.js"],
          },
        })

        const status = await MCP.status()
        expect(status["demo-plugin::layout"].status).toBe("uninitialized")
        expect(status["demo-plugin::defaults"]).toBeUndefined()
        expect(status["demo-plugin::locked"]).toBeUndefined()

        const handle = McpSupervisor.get("demo-plugin::layout")
        expect(handle?.config.startup).toBe("manual")
        expect(handle?.config.listTimeout).toBe(1234)
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

    await Instance.provide({
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

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.get()
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
