import { expect, test } from "bun:test"
import { z } from "zod"
import { capability, compilePluginManifest, definePlugin, operation } from "@ericsanchezok/synergy-plugin"
import { configureRuntimeEndpoint } from "@ericsanchezok/synergy-harness/util/runtime-endpoint"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { createPluginInvocationContext, contributionGatedCapabilities } from "../../src/plugin-runtime/context-factory"
import { testRuntime } from "../support/runtime"
import path from "node:path"
import { HostConnection } from "@ericsanchezok/synergy-harness/host/connection"
import { PluginRuntimeManager } from "../../src/plugin-runtime/manager"
import definition from "../plugin-runtime/fixtures/host-connection-plugin"
import { pathToFileURL } from "node:url"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { getPlugin, resetAllPluginState } from "../../src/plugin/loader"
import { createApprovalRecord, saveApproval, removeApproval } from "../../src/plugin/consent/approval-store"

test("Host connection service is optional and independently gated by the contribution", async () => {
  expect(
    contributionGatedCapabilities(["host.connection.manage"], { requires: [] }).has("host.connection.manage"),
  ).toBe(false)
  const methods: string[] = []
  const input: Parameters<typeof createPluginInvocationContext>[0] = {
    requestId: "request",
    data: { scopeId: "home", directory: "/fixture", actor: { type: "ui" } },
    runtime: { hostVersion: "local", pluginVersion: "1.0.0", pluginGeneration: "generation", protocolVersion: 9 },
    signal: AbortSignal.timeout(5000),
    capabilities: new Set(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    async invokeHost(method) {
      methods.push(method)
      return { url: "http://127.0.0.1:4000/host-connection/gateway", generation: "fixture" }
    },
  }
  expect(createPluginInvocationContext(input).hostConnection).toBeUndefined()
  const context = createPluginInvocationContext({ ...input, capabilities: new Set(["host.connection.manage"]) })
  await context.hostConnection!.endpoint()
  expect(methods).toEqual(["host.connection.endpoint"])
})

test("paired-device Host Services expose no bearer credential and reject missing grants and remote management", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const scope = await directory.scope()
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 4000, generation: "fixture" })
    const manifest = (requires: string[]) =>
      compilePluginManifest(
        definePlugin({
          id: "connection-fixture",
          version: "1.0.0",
          description: "Pairing fixture",
          capabilities: [capability("host.connection.manage")],
          contributions: [
            operation({
              id: "manage",
              type: "command",
              input: z.object({}),
              output: z.object({}),
              requires,
              async handler() {
                return {}
              },
            }),
          ],
        }),
        { generation: "fixture" },
      )
    const call = (
      requires: string[],
      method: Parameters<typeof executePluginHostService>[0]["method"],
      params: unknown = {},
    ) =>
      executePluginHostService({
        pluginId: "connection-fixture",
        pluginDir: directory.path,
        manifest: manifest(requires),
        handlerId: "operation:manage",
        invocation: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
        method,
        params,
        signal: AbortSignal.timeout(5000),
      })
    await expect(call([], "host.connection.endpoint")).rejects.toThrow("does not require")
    expect(await call(["host.connection.manage"], "host.connection.endpoint")).toEqual({
      url: "http://127.0.0.1:4000/host-connection/gateway",
      generation: "fixture",
    })
    const result = await call(["host.connection.manage"], "host.connection.configure", {
      enabled: true,
      name: "Fixture",
    })
    expect(result).not.toHaveProperty("privateKey")
    expect(result).not.toHaveProperty("token")
    const { HostConnection } = await import("@ericsanchezok/synergy-harness/host/connection")
    await expect(
      HostConnection.withRemote("remote-fixture", () => call(["host.connection.manage"], "host.connection.invite")),
    ).rejects.toThrow("local access")
  })
}, 30_000)

test("process RPC preserves remote requester isolation and denies Agent pairing", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const scope = await directory.scope()
    await HostConnection.configure(definition.id, { enabled: true, name: "Fixture" })
    const manager = new PluginRuntimeManager(executePluginHostService)
    const entryPath = path.join(import.meta.dir, "../plugin-runtime/fixtures/host-connection-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "pairing-process",
      runtime: { entry: "runtime/index.js", sha256: "fixture" },
    })
    await manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath })
    const invoke = (actor: { type: "ui" } | { type: "agent"; agent: string; messageId: string; callId: string }) =>
      manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:invite",
        value: {},
        pluginDir: directory.path,
        manifest,
        context: { scopeId: scope.id, directory: directory.path, actor },
      })
    try {
      await expect(invoke({ type: "ui" })).resolves.toMatchObject({ code: expect.any(String) })
      await expect(HostConnection.withRemote("remote-fixture", () => invoke({ type: "ui" }))).rejects.toMatchObject({
        domainCode: "PLUGIN_HOST_CONNECTION_LOCAL_REQUIRED",
      })
      await expect(
        invoke({ type: "agent", agent: "general", messageId: "msg_fixture", callId: "call_fixture" }),
      ).rejects.toMatchObject({ domainCode: "PLUGIN_HOST_CONNECTION_HUMAN_REQUIRED" })
    } finally {
      await manager.stop(manifest.id)
    }
  })
}, 30_000)

test("gateway remains active for another Scope and closes on Scope-free global reset", async () => {
  await using runtime = await testRuntime()
  await using pluginDirectory = await tmpdir()
  await runtime.run(async () => {
    const manifest = compilePluginManifest(definePlugin({ ...definition, contributions: [] }), {
      generation: "gateway-lifecycle",
    })
    await Bun.write(path.join(pluginDirectory.path, "plugin.json"), JSON.stringify(manifest))
    await saveApproval(createApprovalRecord({ pluginId: manifest.id, source: "local", manifest }))
    await using first = await tmpdir({ git: true, config: { plugin: [pathToFileURL(pluginDirectory.path).href] } })
    await using second = await tmpdir({ git: true, config: { plugin: [pathToFileURL(pluginDirectory.path).href] } })
    const firstScope = await first.scope()
    const secondScope = await second.scope()
    try {
      for (const scope of [firstScope, secondScope])
        await ScopeContext.provide({
          scope,
          fn: async () => {
            expect((await getPlugin(manifest.id))?.id).toBe(manifest.id)
          },
        })
      await HostConnection.configure(manifest.id, { enabled: true, name: "Fixture" })
      let closed = 0
      const unwatch = HostConnection.watch("peer", () => closed++)
      try {
        await ScopedState.dispose(firstScope.id)
        expect((await HostConnection.describe()).name).toBe("Fixture")
        expect(closed).toBe(0)
        await resetAllPluginState()
        await expect(HostConnection.describe()).rejects.toThrow("disabled")
        expect(closed).toBe(1)
        await resetAllPluginState()
        expect(closed).toBe(1)
      } finally {
        unwatch()
      }
    } finally {
      await resetAllPluginState()
      await removeApproval(manifest.id)
    }
  })
}, 30_000)

test("a draining process generation cannot re-enable the gateway after owner withdrawal", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const scope = await directory.scope()
    const waiting = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const manager = new PluginRuntimeManager(async (input) => {
      if (input.method === "host.connection.pending") {
        waiting.resolve()
        await released.promise
      }
      return executePluginHostService(input)
    })
    const entryPath = path.join(import.meta.dir, "../plugin-runtime/fixtures/host-connection-plugin.ts")
    const manifest = (generation: string) =>
      compilePluginManifest(definition, {
        generation,
        runtime: { entry: "runtime/index.js", sha256: "fixture" },
      })
    const initial = manifest("connection-old")
    await HostConnection.configure(initial.id, { enabled: true, name: "Fixture" })
    await manager.start({ manifest: initial, pluginDir: path.dirname(entryPath), entryPath })
    const pending = manager.invoke({
      pluginId: initial.id,
      handlerId: "operation:configure",
      value: { wait: true },
      pluginDir: directory.path,
      manifest: initial,
      context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
    })
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await waiting.promise
      await manager.start({ manifest: manifest("connection-new"), pluginDir: path.dirname(entryPath), entryPath })
      await HostConnection.disableOwner(initial.id)
      released.resolve()
      expect(await settled).toBeInstanceOf(Error)
      await expect(HostConnection.describe()).rejects.toThrow("disabled")
    } finally {
      released.resolve()
      await settled
      await manager.stop(initial.id)
    }
  })
}, 30_000)

test("a queued configuration cannot re-enable a stopped owner generation", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const scope = await directory.scope()
    const configuring = Promise.withResolvers<void>()
    const manager = new PluginRuntimeManager(async (input) => {
      if (input.method === "host.connection.configure") configuring.resolve()
      return executePluginHostService(input)
    })
    const entryPath = path.join(import.meta.dir, "../plugin-runtime/fixtures/host-connection-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "connection-queued",
      runtime: { entry: "runtime/index.js", sha256: "fixture" },
    })
    await HostConnection.configure(manifest.id, { enabled: true, name: "Fixture" })
    await manager.start({
      manifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
      mode: "inProcess",
      trustedBuiltin: true,
    })
    const { Lock } = await import("@ericsanchezok/synergy-harness/util/lock")
    const claim = await Lock.write("host-connection-configuration")
    let hasReleasedClaim = false
    const pending = manager.invoke({
      pluginId: manifest.id,
      handlerId: "operation:configure",
      value: { wait: false },
      pluginDir: directory.path,
      manifest,
      context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
    })
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await configuring.promise
      await manager.stop(manifest.id)
      const withdrawal = HostConnection.disableOwner(manifest.id)
      claim[Symbol.dispose]()
      hasReleasedClaim = true
      await withdrawal
      expect(await settled).toBeInstanceOf(Error)
      await expect(HostConnection.describe()).rejects.toThrow("disabled")
    } finally {
      if (!hasReleasedClaim) claim[Symbol.dispose]()
      await settled
      await manager.stop(manifest.id)
    }
  })
}, 30_000)
