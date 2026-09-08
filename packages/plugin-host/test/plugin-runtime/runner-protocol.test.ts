import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { PluginToHost } from "../../src/plugin-runtime/protocol"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"
import { spawnPluginProcess } from "../../src/plugin-runtime/process-host"
import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from "../../src/plugin-runtime/protocol"

describe("plugin runtime runner protocol", () => {
  test("echoes the protocol selected by the parent host during activation", async () => {
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const selectedProtocol = PLUGIN_RUNTIME_PROTOCOL_VERSION - 1
    const ready = Promise.withResolvers<Extract<PluginToHost, { type: "ready" }>>()
    const host = spawnPluginProcess({
      entryPath,
      pluginDir: path.dirname(entryPath),
      activation: {
        pluginId: "runtime-fixture",
        version: "1.0.0",
        generation: "runner-protocol-fixture",
        hostVersion: "test-host",
        protocolVersion: selectedProtocol,
        capabilities: [],
        runtimeLimits: DEFAULT_LIMITS,
      },
      onReady: ready.resolve,
      onHostRequest: async () => undefined,
      onHeartbeat: () => undefined,
      onLog: () => undefined,
      onExit: (exitCode, signal) => {
        ready.reject(new Error(`Plugin runtime exited before ready (${exitCode ?? signal ?? "unknown"})`))
      },
    })

    try {
      await expect(ready.promise).resolves.toMatchObject({
        protocolVersion: selectedProtocol,
        generation: "runner-protocol-fixture",
      })
    } finally {
      await host.stop(1_000)
    }
  })
})
