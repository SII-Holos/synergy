import { afterEach, describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, lifecycleInstall } from "@ericsanchezok/synergy-plugin"
import { deliverInstallLifecycle, runPendingInstallLifecycles } from "../../src/plugin/install"
import type { LoadedPlugin } from "../../src/plugin/loader"
import * as Lockfile from "../../src/plugin/lockfile"
import { ScopeContext } from "../../src/scope/context"
import { configureRuntimeEndpoint } from "../../src/server/runtime-endpoint"
import { tmpdir } from "../fixture/fixture"

const manifest = compilePluginManifest(
  definePlugin({
    id: "install-lifecycle-test",
    version: "1.0.0",
    description: "Install lifecycle fixture",
    contributions: [lifecycleInstall({ id: "setup", handler: async () => undefined })],
  }),
  {
    generation: "install-lifecycle-generation",
    runtime: { entry: "runtime/index.js", sha256: "test" },
  },
)

function plugin(): LoadedPlugin {
  return {
    id: manifest.id,
    name: manifest.name,
    manifest,
    pluginDir: "/plugin",
    source: "local",
    spec: "file:///plugin",
    enabledScopes: new Set<string>(),
    contributionHealth: new Map(),
  } as LoadedPlugin
}

async function seedLockfile(status: "pending" | "done" | "failed") {
  const current = await Lockfile.read()
  await Lockfile.write({
    ...current,
    plugins: {
      ...current.plugins,
      [manifest.id]: {
        spec: "file:///plugin",
        source: "local",
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        generation: manifest.artifacts.generation,
        resolved: "/plugin/plugin.json",
        manifestHash: "test",
        approvalId: manifest.id,
        lifecycleInstall: status,
      },
    },
  })
}

function recordingServices() {
  let ensured = 0
  let invoked = 0
  const services = {
    ensureRuntime: async () => {
      ensured++
    },
    invoke: async () => {
      invoked++
    },
    onFailure: () => undefined,
  }
  return { services, counts: () => ({ ensured, invoked }) }
}

describe("plugin install lifecycle delivery", () => {
  afterEach(() => configureRuntimeEndpoint(undefined))

  test("queues as pending outside a host process without touching the runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await deliverInstallLifecycle(plugin(), { services })
        expect(result).toEqual({ status: "pending" })
      },
    })
    expect(counts()).toEqual({ ensured: 0, invoked: 0 })
  })

  test("delivers immediately inside a host process and persists done", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await deliverInstallLifecycle(plugin(), { catchUpStarted: false, services })
        expect(result).toEqual({ status: "completed" })
      },
    })
    expect(counts()).toEqual({ ensured: 1, invoked: 1 })
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("done")
  })

  test("persists failed state without throwing", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const { services } = recordingServices()
    services.invoke = async () => {
      throw new Error("installer boom")
    }
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await deliverInstallLifecycle(plugin(), { catchUpStarted: false, services })
        expect(result.status).toBe("failed")
        expect((result as { error?: string }).error).toBe("installer boom")
      },
    })
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("failed")
  })

  test("boot catch-up delivers pending install lifecycles", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const results = await runPendingInstallLifecycles({ plugins: [plugin()], services })
        expect(results).toEqual([{ status: "completed" }])
      },
    })
    expect(counts()).toEqual({ ensured: 1, invoked: 1 })
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("done")
  })

  test("boot catch-up skips plugins whose generation no longer matches", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const stale = { ...plugin(), manifest: { ...manifest, artifacts: { ...manifest.artifacts, generation: "other" } } }
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const results = await runPendingInstallLifecycles({ plugins: [stale], services })
        expect(results).toEqual([])
      },
    })
    expect(counts()).toEqual({ ensured: 0, invoked: 0 })
  })
})
