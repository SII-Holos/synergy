import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  capability,
  compilePluginManifest,
  definePlugin,
  PluginHostServiceErrorCode,
} from "@ericsanchezok/synergy-plugin"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { createAuthStore } from "../../src/plugin/store"
import { PluginPaths } from "../../src/plugin/paths"

test("invocation context crosses the real Host Services boundary for scoped files, sessions, settings and plugin secrets", async () => {
  await using tmp = await tmpdir({ git: true })
  await using other = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const pluginId = `storage-${crypto.randomUUID()}`
  const capabilities = [
    "workspace.read",
    "workspace.write",
    "session.read",
    "session.control",
    "settings.read",
    "secrets",
  ] as const
  const manifest = compilePluginManifest(
    definePlugin({
      id: pluginId,
      version: "1.0.0",
      description: "Storage fixture",
      capabilities: capabilities.map((name) => capability(name)),
      contributions: [],
    }),
    { generation: "fixture" },
  )
  const invocation = { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" as const } }
  const signal = AbortSignal.timeout(5000)
  const context = createPluginInvocationContext({
    requestId: "storage",
    data: invocation,
    runtime: { hostVersion: "test", pluginVersion: "1.0.0", pluginGeneration: "fixture", protocolVersion: 4 },
    capabilities: new Set(capabilities),
    signal,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    invokeHost: (method, params) =>
      executePluginHostService({ pluginId, pluginDir: tmp.path, manifest, invocation, signal, method, params }),
  })
  const own = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "owned session" }) })
  const foreign = await ScopeContext.provide({
    scope: await other.scope(),
    fn: () => Session.create({ title: "foreign session" }),
  })
  try {
    await context.workspace?.write?.("nested/result.txt", "fixture payload")
    expect(await context.workspace?.read?.("nested/result.txt")).toBe("fixture payload")
    expect(await context.workspace?.metadata?.()).toEqual({ scopeId: scope.id, directory: tmp.path })
    await expect(context.workspace!.write!("../outside.txt", "escape")).rejects.toThrow("escapes the active Scope")
    expect(await context.session?.get?.(own.id)).toMatchObject({ id: own.id, title: "owned session" })
    await expect(context.session!.get!(foreign.id)).rejects.toMatchObject({
      code: PluginHostServiceErrorCode.SESSION_SCOPE_MISMATCH,
    })
    await context.session?.abort?.(own.id)
    expect(await context.settings?.get?.()).toEqual({})
    expect(await context.secrets?.get("token")).toBeUndefined()
    await context.secrets?.set("token", "fixture opaque value")
    expect(await context.secrets?.get("token")).toBe("fixture opaque value")
    expect(await createAuthStore(pluginId).has("token")).toBe(true)
    expect(await createAuthStore(`${pluginId}-other`).get("token")).toBeUndefined()
    await context.secrets?.delete("token")
    expect(await createAuthStore(pluginId).has("token")).toBe(false)
    await expect(
      executePluginHostService({
        pluginId,
        pluginDir: tmp.path,
        manifest: { ...manifest, capabilities: [] },
        invocation,
        signal,
        method: "workspace.read",
        params: { path: "nested/result.txt" },
      }),
    ).rejects.toThrow('does not declare capability "workspace.read"')
  } finally {
    await fs.rm(path.dirname(PluginPaths.authFile(pluginId)), { recursive: true, force: true })
  }
})
