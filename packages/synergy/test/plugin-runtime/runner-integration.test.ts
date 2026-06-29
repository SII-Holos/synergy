import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { PluginRuntimeSupervisor } from "../../src/plugin-runtime/supervisor"
import { RuntimeRegistry, type RuntimeMode } from "../../src/plugin-runtime/registry"
import { PluginLogBuffer } from "../../src/plugin-runtime/logs"

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function writeRuntimePlugin(dir: string, pluginId: string) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: pluginId,
        version: "0.1.0",
        main: "./src/index.ts",
        runtime: {
          resources: {
            startupTimeoutMs: 5000,
          },
        },
        contributes: {
          tools: [
            {
              name: "echo",
              title: "Echo",
              description: "Echo args and context",
              capabilities: {
                filesystem: "none",
                shell: false,
                network: false,
              },
            },
          ],
        },
        permissions: {
          tools: {
            filesystem: "none",
            shell: false,
            network: false,
            mcp: "none",
          },
        },
      },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "src", "index.ts"),
    `export default {
  id: "${pluginId}",
  async init() {
    return {
      tool: {
        echo: {
          description: "Echo args and context",
          args: {},
          async execute(args, context) {
            return { output: String(args.text) + ":" + context.sessionID }
          }
        }
      },
      async "experimental.text.complete"(_input, output) {
        output.text = output.text + "!"
        return { text: output.text + "?" }
      }
    }
  }
}
`,
  )
}

describe("isolated plugin runner integration", () => {
  for (const mode of ["worker", "process"] as RuntimeMode[]) {
    test(`${mode} runtime registers tools, invokes tools, triggers hooks, heartbeats, reloads, and stops`, async () => {
      const pluginId = `runner-${mode}-${Date.now().toString(36)}`
      await using tmp = await tmpdir({ init: (dir) => writeRuntimePlugin(dir, pluginId) })
      const supervisor = new PluginRuntimeSupervisor({
        registry: new RuntimeRegistry(),
        logs: new PluginLogBuffer(),
        persist: { load: async () => [], save: async () => {} },
      })

      const entry = await supervisor.start(pluginId, {
        mode,
        entryPath: path.join(tmp.path, "src", "index.ts"),
        pluginDir: tmp.path,
        source: "local",
        serverUrl: "http://localhost:3000",
      })

      try {
        await waitFor(() => entry.state === "ready", `${mode} runtime did not become ready`)
        expect(entry.tools?.map((tool) => tool.id)).toEqual(["echo"])
        expect(entry.hooks).toEqual(["experimental.text.complete"])

        const toolResult = await supervisor.invokeTool(
          pluginId,
          "echo",
          { text: "hello" },
          { sessionID: "session-1", messageID: "message-1", agent: "synergy", directory: tmp.path },
        )
        expect(toolResult).toEqual({ output: "hello:session-1" })

        const hookResult = await supervisor.triggerHook(pluginId, "experimental.text.complete", {}, { text: "done" })
        expect(hookResult).toEqual({ text: "done!?" })

        entry.send?.({ type: "ping" })
        await waitFor(() => entry.lastHeartbeatAt !== undefined, `${mode} runtime did not heartbeat`)

        const reloaded = await supervisor.reload(pluginId)
        await waitFor(() => reloaded.state === "ready", `${mode} runtime did not reload`)
        expect(reloaded.restarts).toBe(1)
      } finally {
        await supervisor.stop(pluginId, true)
      }

      expect(supervisor.getRuntimeState(pluginId)).toBe("stopped")
    })
  }
})
