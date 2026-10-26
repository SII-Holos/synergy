import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import type { PluginToHost } from "../../src/plugin-runtime/protocol"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"
import { spawnPluginProcess } from "../../src/plugin-runtime/process-host"
import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from "../../src/plugin-runtime/protocol"

describe("plugin runtime runner protocol", () => {
  test("passes installation pins added after process startup into the real worker environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-worker-pin-"))
    const pin = { id: crypto.randomUUID(), sha256: "a".repeat(64) }
    const launcher = path.join(root, "launcher.ts")
    await Bun.write(
      launcher,
      `
      const pin = JSON.parse(process.env.SYNERGY_INSTALLATION_PIN ?? "null")
      if (!pin || process.env.SYNERGY_INSTALLATION_ROOT !== ${JSON.stringify(root)}) process.exit(1)
      process.on("message", (message) => {
        if (message.type === "shutdown") process.exit(0)
        if (message.type === "activate") process.send({type:"ready", protocolVersion:message.input.protocolVersion, generation:pin.id, handlerIds:[]})
      })
    `,
    )
    const environment = {
      SYNERGY_INSTALLATION_PIN: JSON.stringify(pin),
      SYNERGY_INSTALLATION_ROOT: root,
      SYNERGY_LAUNCHER_COMMAND: JSON.stringify([process.execPath, launcher]),
    }
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
    const ready = Promise.withResolvers<Extract<PluginToHost, { type: "ready" }>>()
    let host: ReturnType<typeof spawnPluginProcess> | undefined
    try {
      Object.assign(process.env, environment)
      host = spawnPluginProcess({
        entryPath: path.join(root, "plugin.js"),
        pluginDir: root,
        activation: {
          pluginId: "pin-fixture",
          version: "1.0.0",
          generation: pin.id,
          hostVersion: "test",
          protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
          capabilities: [],
          runtimeLimits: DEFAULT_LIMITS,
        },
        onReady: ready.resolve,
        onHostRequest: async () => undefined,
        onHeartbeat: () => undefined,
        onLog: () => undefined,
        onExit: (code) => ready.reject(new Error(`Pinned plugin worker exited (${code})`)),
      })
      await expect(ready.promise).resolves.toMatchObject({ generation: pin.id })
    } finally {
      await host?.stop(1000)
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  })

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
