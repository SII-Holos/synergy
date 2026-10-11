import { expect, spyOn, test } from "bun:test"
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
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  SqliteDriver,
  postgresCommitFixture,
  type SqlConnection,
  type SqlTransactionOptions,
} from "@ericsanchezok/synergy-harness/test/support/internals"

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

test("a delayed old-generation finish cannot recreate a withdrawn pairing grant", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  await using directory = await tmpdir()
  const waiting = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: target.bind(async (request: Request) => {
      waiting.resolve()
      await released.promise
      return Response.json(await HostConnection.pairingStatus(await request.json()))
    }),
  })
  const targetDescriptor = await target.run(() =>
    HostConnection.configure(definition.id, {
      enabled: true,
      name: "Target",
      url: server.url.origin,
    }),
  )
  await source.run(() => HostConnection.configure(definition.id, { enabled: true, name: "Source" }))
  const invitation = await target.run(() => HostConnection.invite())
  const pairing = await source.run(() => HostConnection.pairRequest(targetDescriptor, invitation.code))
  await target.run(() => HostConnection.receivePair(pairing))
  await target.run(() => HostConnection.approve(pairing.requestID))
  try {
    await source.run(async () => {
      const scope = await directory.scope()
      const manager = new PluginRuntimeManager(executePluginHostService)
      const entryPath = path.join(import.meta.dir, "../plugin-runtime/fixtures/host-connection-plugin.ts")
      const manifest = (generation: string) =>
        compilePluginManifest(definition, {
          generation,
          runtime: { entry: "runtime/index.js", sha256: "fixture" },
        })
      const initial = manifest("finish-old")
      await manager.start({ manifest: initial, pluginDir: path.dirname(entryPath), entryPath })
      const pending = manager.invoke({
        pluginId: initial.id,
        handlerId: "operation:finish",
        value: { requestID: pairing.requestID },
        pluginDir: directory.path,
        manifest: initial,
        context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
      })
      const settled = pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      try {
        await Promise.race([
          waiting.promise,
          settled.then((error) => {
            throw error ?? new Error("finish returned before status request")
          }),
        ])
        await manager.start({ manifest: manifest("finish-new"), pluginDir: path.dirname(entryPath), entryPath })
        await HostConnection.disableOwner(initial.id)
        await HostConnection.configure(initial.id, { enabled: true, name: "Source" })
        await HostConnection.revoke(targetDescriptor.id)
        const before = await Storage.read<Record<string, unknown>>(["host_connection", "outgoing", pairing.requestID])
        released.resolve()
        expect(await settled).toBeInstanceOf(Error)
        expect(await HostConnection.peers()).toEqual([])
        expect(await Storage.read<Record<string, unknown>>(["host_connection", "outgoing", pairing.requestID])).toEqual(
          before,
        )
        await manager.invoke({
          pluginId: initial.id,
          handlerId: "operation:finish",
          value: { requestID: pairing.requestID },
          pluginDir: directory.path,
          manifest: manifest("finish-new"),
          context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
        })
        expect((await HostConnection.peers()).map((peer) => peer.id)).toEqual([targetDescriptor.id])
      } finally {
        released.resolve()
        await settled
        await manager.stop(initial.id)
      }
    })
  } finally {
    released.resolve()
    await server.stop(true)
  }
}, 30_000)

test("an approval queued on the pairing lock cannot write after generation withdrawal", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  await using directory = await tmpdir()
  const descriptor = await target.run(() => HostConnection.configure(definition.id, { enabled: true, name: "Target" }))
  await source.run(() => HostConnection.configure(definition.id, { enabled: true, name: "Source" }))
  const invitation = await target.run(() => HostConnection.invite())
  const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
  await target.run(() => HostConnection.receivePair(pairing))
  await target.run(async () => {
    const scope = await directory.scope()
    const queued = Promise.withResolvers<void>()
    const write = Lock.write
    const lockKey = `host-connection-pair:${pairing.requestID}`
    const claim = await write(lockKey)
    using _write = spyOn(Lock, "write").mockImplementation((key) => {
      const pending = write(key)
      if (key === lockKey) queued.resolve()
      return pending
    })
    const manager = new PluginRuntimeManager(executePluginHostService)
    const entryPath = path.join(import.meta.dir, "../plugin-runtime/fixtures/host-connection-plugin.ts")
    const manifest = (generation: string) =>
      compilePluginManifest(definition, {
        generation,
        runtime: { entry: "runtime/index.js", sha256: "fixture" },
      })
    const initial = manifest("approve-old")
    let hasReleasedClaim = false
    await manager.start({ manifest: initial, pluginDir: path.dirname(entryPath), entryPath })
    const pending = manager.invoke({
      pluginId: initial.id,
      handlerId: "operation:approve",
      value: { requestID: pairing.requestID },
      pluginDir: directory.path,
      manifest: initial,
      context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
    })
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await Promise.race([
        queued.promise,
        settled.then((error) => {
          throw error ?? new Error("approve returned before lock admission")
        }),
      ])
      await manager.start({ manifest: manifest("approve-new"), pluginDir: path.dirname(entryPath), entryPath })
      await HostConnection.disableOwner(initial.id)
      await HostConnection.configure(initial.id, { enabled: true, name: "Target" })
      const before = await Storage.read<Record<string, unknown>>(["host_connection", "incoming", pairing.requestID])
      claim[Symbol.dispose]()
      hasReleasedClaim = true
      expect(await settled).toBeInstanceOf(Error)
      expect(await HostConnection.peers()).toEqual([])
      expect(await Storage.read<Record<string, unknown>>(["host_connection", "incoming", pairing.requestID])).toEqual(
        before,
      )
      await manager.invoke({
        pluginId: initial.id,
        handlerId: "operation:approve",
        value: { requestID: pairing.requestID },
        pluginDir: directory.path,
        manifest: manifest("approve-new"),
        context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
      })
      expect((await HostConnection.peers()).map((peer) => peer.id)).toEqual([pairing.requester.id])
    } finally {
      if (!hasReleasedClaim) claim[Symbol.dispose]()
      await settled
      await manager.stop(initial.id)
    }
  })
}, 30_000)

test.each(["replacement", "cancellation", "current"] as const)(
  "PostgreSQL post-body ownership wait fences %s approval before COMMIT",
  async (retirement) => {
    await using source = await testRuntime()
    await using target = await testRuntime()
    await using directory = await tmpdir()
    const descriptor = await target.run(() =>
      HostConnection.configure(definition.id, { enabled: true, name: "Target" }),
    )
    await source.run(() => HostConnection.configure(definition.id, { enabled: true, name: "Source" }))
    const invitation = await target.run(() => HostConnection.invite())
    const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
    await target.run(() => HostConnection.receivePair(pairing))
    await target.run(async () => {
      const scope = await directory.scope()
      const manager = new PluginRuntimeManager(executePluginHostService)
      const entryPath = path.join(import.meta.dir, "../plugin-runtime/fixtures/host-connection-plugin.ts")
      const manifest = (generation: string) =>
        compilePluginManifest(definition, {
          generation,
          runtime: { entry: "runtime/index.js", sha256: "fixture" },
        })
      const initial = manifest("commit-old")
      await manager.start({ manifest: initial, pluginDir: path.dirname(entryPath), entryPath })
      await manager.invoke({
        pluginId: initial.id,
        handlerId: "operation:configure",
        value: { wait: true },
        pluginDir: directory.path,
        manifest: initial,
        context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
      })
      await HostConnection.invite()
      const beforeInvitation = await Storage.read<Record<string, unknown>>(["host_connection", "invitation"])
      const before = await Storage.read<Record<string, unknown>>(["host_connection", "incoming", pairing.requestID])
      const reached = Promise.withResolvers<ReturnType<typeof postgresCommitFixture>>()
      const transaction = SqliteDriver.prototype.transaction
      using _transaction = spyOn(SqliteDriver.prototype, "transaction").mockImplementation(async function <T>(
        this: SqliteDriver,
        body: (connection: SqlConnection) => Promise<T>,
        options?: SqlTransactionOptions,
      ) {
        if (options?.readOnly) return (await transaction.call(this, body, options)) as T
        return (await transaction.call(this, async (connection: SqlConnection) => {
          const fixture = postgresCommitFixture(
            connection,
            (statement, values) =>
              statement.startsWith("INSERT INTO storage_records(") &&
              values.includes(JSON.stringify(["host_connection", "peers", pairing.requester.id])),
          )
          void fixture.waiting.promise.then(() => reached.resolve(fixture))
          return fixture.driver.transaction(body, options)
        })) as T
      })
      const controller = new AbortController()
      const pending = manager.invoke({
        pluginId: initial.id,
        handlerId: "operation:approve",
        value: { requestID: pairing.requestID },
        pluginDir: directory.path,
        manifest: initial,
        signal: controller.signal,
        context: { scopeId: scope.id, directory: directory.path, actor: { type: "ui" } },
      })
      const settled = pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      const fixture = await Promise.race([
        reached.promise,
        settled.then((error) => {
          throw error
        }),
      ])
      try {
        await Promise.race([
          fixture.waiting.promise,
          settled.then((error) => {
            throw error
          }),
        ])
        if (retirement === "replacement")
          await manager.start({ manifest: manifest("commit-new"), pluginDir: path.dirname(entryPath), entryPath })
        if (retirement === "cancellation") controller.abort(new Error("approval cancelled during ownership check"))
        fixture.released.resolve()
        const failure = await settled
        if (retirement === "current") {
          expect(failure).toBeUndefined()
          expect((await HostConnection.peers()).map((peer) => peer.id)).toEqual([pairing.requester.id])
          expect(fixture.statements).toContain("COMMIT")
        } else {
          expect(failure).toBeInstanceOf(Error)
          expect(await HostConnection.peers()).toEqual([])
          expect(
            await Storage.read<Record<string, unknown>>(["host_connection", "incoming", pairing.requestID]),
          ).toEqual(before)
          expect(await Storage.read<Record<string, unknown>>(["host_connection", "invitation"])).toEqual(
            beforeInvitation,
          )
          expect(fixture.statements).not.toContain("COMMIT")
          expect(fixture.statements).toContain("ROLLBACK")
        }
      } finally {
        fixture.released.resolve()
        await settled
        await manager.stop(initial.id)
      }
    })
  },
  30_000,
)
