import { describe, expect, test } from "bun:test"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import type { PluginActor } from "@ericsanchezok/synergy-plugin"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { tmpdir } from "../fixture/fixture"

function manifest(capabilities: string[] = ["shell.execute"]) {
  return compilePluginManifest(
    definePlugin({
      id: "shell-host-test",
      version: "1.0.0",
      description: "Plugin shell Host Service test",
      capabilities: capabilities.map((id) => capability(id)),
      contributions: [],
    }),
    { generation: "shell-host-generation" },
  )
}

async function invoke(input: {
  directory: string
  scopeId: string
  params: Record<string, unknown>
  capabilities?: string[]
  actor?: PluginActor
  signal?: AbortSignal
}) {
  const compiled = manifest(input.capabilities)
  return executePluginHostService({
    pluginId: compiled.id,
    pluginDir: input.directory,
    manifest: compiled,
    invocation: {
      scopeId: input.scopeId,
      directory: input.directory,
      actor: input.actor ?? ({ type: "cli" } as unknown as PluginActor),
    },
    method: "shell.run" as never,
    params: input.params,
    signal: input.signal ?? AbortSignal.timeout(5_000),
  }) as Promise<{ stdout: string; stderr: string; exitCode: number }>
}

describe("plugin shell.run Host Service", () => {
  test("executes an argv tuple in the active Scope and preserves non-zero process output", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const script = [
      "process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1) }))",
      'process.stderr.write("setup warning")',
      "process.exit(7)",
    ].join(";")

    const result = await invoke({
      directory: tmp.path,
      scopeId: scope.id,
      params: { command: [process.execPath, "-e", script, "literal value"] },
    })

    expect(result.exitCode).toBe(7)
    expect(result.stderr).toBe("setup warning")
    expect(JSON.parse(result.stdout)).toEqual({ cwd: tmp.path, argv: ["literal value"] })
  })

  test("requires shell.execute and rejects shell strings or execution overrides", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const command = [process.execPath, "-e", 'process.stdout.write("ok")']

    await expect(
      invoke({ directory: tmp.path, scopeId: scope.id, capabilities: [], params: { command } }),
    ).rejects.toThrow('does not declare capability "shell.execute"')
    await expect(
      invoke({ directory: tmp.path, scopeId: scope.id, params: { command: command.join(" ") } }),
    ).rejects.toThrow()
    await expect(invoke({ directory: tmp.path, scopeId: scope.id, params: { command, cwd: "/tmp" } })).rejects.toThrow()
    await expect(
      invoke({ directory: tmp.path, scopeId: scope.id, params: { command, env: { TOKEN: "secret" } } }),
    ).rejects.toThrow()
  })
})
