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
