import { describe, expect, test } from "bun:test"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { invokePluginCliCommand, resolvePluginCliCommand } from "../../src/plugin/cli-command"

const command = {
  kind: "cli.command",
  id: "setup",
  description: "Initialize frontend tooling",
  options: {
    "dry-run": { type: "boolean", description: "Print without executing" },
    json: { type: "boolean", description: "Return JSON" },
  },
  timeoutMs: 15_000,
} as const

function manifest(generation = "generation-one") {
  return {
    manifestVersion: 1,
    apiVersion: "3.0",
    id: "frontend-kit",
    name: "Frontend Kit",
    version: "1.0.0",
    description: "CLI contribution fixture",
    capabilities: [{ id: "shell.execute" }],
    contributions: [command],
    artifacts: {
      generation,
      runtime: { entry: "runtime/index.js", sha256: "a".repeat(64) },
    },
  } as unknown as PluginManifestType
}

describe("plugin CLI command domain", () => {
  test("resolves only exact declared CLI command metadata", () => {
    expect(resolvePluginCliCommand(manifest(), "setup")).toEqual(command)
    expect(() => resolvePluginCliCommand(manifest(), "missing")).toThrow("Plugin CLI command not found: missing")
  })

  test("invokes the active process generation with a CLI actor and preserves process output", async () => {
    const calls: unknown[] = []
    const plugin = {
      id: "frontend-kit",
      pluginDir: "/plugin",
      manifest: manifest(),
      enabledScopes: new Set(["scope-one"]),
    }

    const result = await invokePluginCliCommand(
      {
        pluginId: "frontend-kit",
        commandId: "setup",
        args: { "dry-run": true, json: true },
        signal: AbortSignal.timeout(5_000),
      },
      {
        scope: { id: "scope-one", directory: "/workspace" },
        getPlugin: async () => plugin as never,
        ensureRuntime: async () => undefined,
        invoke: async (input: unknown) => {
          calls.push(input)
          return { stdout: '{"ok":true}\n', stderr: "setup warning\n", exitCode: 7 }
        },
      },
    )

    expect(result).toEqual({ stdout: '{"ok":true}\n', stderr: "setup warning\n", exitCode: 7 })
    expect(calls).toEqual([
      expect.objectContaining({
        pluginId: "frontend-kit",
        handlerId: "cli.command:setup",
        value: { "dry-run": true, json: true },
        context: {
          scopeId: "scope-one",
          directory: "/workspace",
          actor: { type: "cli" },
        },
        timeoutMs: 15_000,
      }),
    ])
  })

  test("fails closed for disabled plugins and stale command metadata", async () => {
    const disabled = {
      id: "frontend-kit",
      pluginDir: "/plugin",
      manifest: manifest(),
      enabledScopes: new Set<string>(),
    }
    await expect(
      invokePluginCliCommand(
        { pluginId: "frontend-kit", commandId: "setup", args: {} },
        {
          scope: { id: "scope-one", directory: "/workspace" },
          getPlugin: async () => disabled as never,
          ensureRuntime: async () => undefined,
          invoke: async () => ({ exitCode: 0 }),
        },
      ),
    ).rejects.toThrow("Plugin is not enabled in this Scope: frontend-kit")
  })
})
