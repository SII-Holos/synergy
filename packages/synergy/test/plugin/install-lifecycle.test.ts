import { afterEach, describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, lifecycleInstall } from "@ericsanchezok/synergy-plugin"
import {
  deliverInstallLifecycle,
  retryPluginInstallLifecycle,
  runPendingInstallLifecycles,
} from "../../src/plugin/install"
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

async function seedLockfile(status: "pending" | "completed" | "failed") {
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

  test("delivers immediately inside a host process and persists completed", async () => {
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
    expect(locked?.lifecycleInstall).toBe("completed")
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
    expect(locked?.lifecycleInstall).toBe("completed")
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

  test("retry refuses a completed install", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("completed")
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await retryPluginInstallLifecycle(manifest.id, services)
        expect(result).toEqual({ status: "completed" })
      },
    })
    expect(counts()).toEqual({ ensured: 0, invoked: 0 })
  })

  test("retry re-queues a failed install outside a host process", async () => {
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("failed")
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await retryPluginInstallLifecycle(manifest.id)
        expect(result).toEqual({ status: "pending" })
      },
    })
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("pending")
  })

  test("retry delivers immediately inside a host process", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("failed")
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await retryPluginInstallLifecycle(manifest.id, services, plugin())
        expect(result).toEqual({ status: "completed" })
      },
    })
    expect(counts()).toEqual({ ensured: 1, invoked: 1 })
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("completed")
  })

  test("retry reports no contribution for plugins without lifecycle.install", async () => {
    await using tmp = await tmpdir({ git: true })
    const noInstall = compilePluginManifest(
      definePlugin({
        id: "no-install-contribution",
        version: "1.0.0",
        description: "No lifecycle fixture",
        contributions: [],
      }),
      {
        generation: "no-install-generation",
        runtime: { entry: "runtime/index.js", sha256: "test" },
      },
    )
    await Lockfile.write({
      ...(await Lockfile.read()),
      plugins: {
        "no-install-contribution": {
          spec: "file:///plugin",
          source: "local",
          version: noInstall.version,
          apiVersion: noInstall.apiVersion,
          generation: noInstall.artifacts.generation,
          resolved: "/plugin/plugin.json",
          manifestHash: "test",
          approvalId: noInstall.id,
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(retryPluginInstallLifecycle("no-install-contribution")).rejects.toThrow(
          "does not declare a lifecycle.install contribution",
        )
      },
    })
  })

  test("delivery converges a stale pending entry for plugins without lifecycle.install", async () => {
    await using tmp = await tmpdir({ git: true })
    const noInstall = compilePluginManifest(
      definePlugin({
        id: "no-install-converge",
        version: "1.0.0",
        description: "No lifecycle fixture",
        contributions: [],
      }),
      {
        generation: "no-install-converge-generation",
        runtime: { entry: "runtime/index.js", sha256: "test" },
      },
    )
    const noInstallPlugin = {
      id: noInstall.id,
      name: noInstall.name,
      manifest: noInstall,
      pluginDir: "/plugin",
      source: "local" as const,
      spec: "file:///plugin",
      enabledScopes: new Set<string>(),
      contributionHealth: new Map(),
    } as LoadedPlugin
    // Simulate an entry left "pending" by an earlier version that wrote the field for
    // every fresh install regardless of contribution.
    await Lockfile.write({
      ...(await Lockfile.read()),
      plugins: {
        "no-install-converge": {
          spec: "file:///plugin",
          source: "local",
          version: noInstall.version,
          apiVersion: noInstall.apiVersion,
          generation: noInstall.artifacts.generation,
          resolved: "/plugin/plugin.json",
          manifestHash: "test",
          approvalId: noInstall.id,
          lifecycleInstall: "pending",
        },
      },
    })
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await deliverInstallLifecycle(noInstallPlugin, { services })
        expect(result).toEqual({ status: "skipped" })
      },
    })
    expect(counts()).toEqual({ ensured: 0, invoked: 0 })
    const locked = (await Lockfile.read()).plugins["no-install-converge"]
    expect(locked?.lifecycleInstall).toBe("completed")
  })

  test("runPendingInstallLifecycles delivers runtime.started catch-up when requested", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const { services, counts } = recordingServices()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const results = await runPendingInstallLifecycles({
          plugins: [plugin()],
          services,
          catchUpStarted: true,
        })
        expect(results).toEqual([{ status: "completed" }])
      },
    })
    expect(counts()).toEqual({ ensured: 1, invoked: 1 })
  })
})
