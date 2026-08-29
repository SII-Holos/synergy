import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { compilePluginManifest, definePlugin, lifecycleInstall } from "@ericsanchezok/synergy-plugin"
import {
  add,
  deliverInstallLifecycle,
  PluginInstallLifecycleGenerationMismatchError,
  retryPluginInstallLifecycle,
  runPendingInstallLifecycles,
} from "../../src/plugin/install"
import type { LoadedPlugin } from "../../src/plugin/loader"
import * as Lockfile from "../../src/plugin/lockfile"
import { ScopeContext } from "../../src/scope/context"
import { configureRuntimeEndpoint } from "../../src/util/runtime-endpoint"
import { sha256File } from "../../src/util/crypto"
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

  test("runPendingInstallLifecycles converges a stale pending entry for plugins without lifecycle.install", async () => {
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
        // Exercised through the boot/reload entry point so the "pending" filter that
        // gates the real catch-up path is covered, not just the delivery helper.
        const results = await runPendingInstallLifecycles({ plugins: [noInstallPlugin], services })
        expect(results).toEqual([{ status: "skipped" }])
      },
    })
    expect(counts()).toEqual({ ensured: 0, invoked: 0 })
    const locked = (await Lockfile.read()).plugins["no-install-converge"]
    expect(locked?.lifecycleInstall).toBe("completed")
  })

  test("add commits a no-contribution fresh install without the lifecycleInstall field", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginDir = path.join(tmp.path, "no-install-add-path")
    const runtimePath = path.join(pluginDir, "runtime", "index.js")
    await Bun.write(runtimePath, `export default {}\n`)
    const noInstall = compilePluginManifest(
      definePlugin({
        id: "no-install-add-path",
        version: "1.0.0",
        description: "No lifecycle fixture",
        contributions: [],
      }),
      {
        generation: "no-install-add-path-generation",
        runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
      },
    )
    await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(noInstall))
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const added = await add(pathToFileURL(pluginDir).href, { skipConsent: true, source: "local" })
        expect(added.installLifecycle).toEqual({ status: "skipped" })
      },
    })
    // The committed entry must exist and not carry lifecycleInstall, so retry-install
    // reports "no contribution" and boot/reload catch-up never reprocesses it.
    const locked = (await Lockfile.read()).plugins["no-install-add-path"]
    expect(locked).toBeDefined()
    expect(locked?.lifecycleInstall).toBeUndefined()
    // Prove the boot/reload filter never re-selects a field-absent committed entry.
    const noInstallPlugin = {
      id: noInstall.id,
      name: noInstall.name,
      manifest: noInstall,
      pluginDir,
      source: "local" as const,
      spec: pathToFileURL(pluginDir).href,
      enabledScopes: new Set<string>(),
      contributionHealth: new Map(),
    } as LoadedPlugin
    const results = await runPendingInstallLifecycles({ plugins: [noInstallPlugin] })
    expect(results).toEqual([])
  })

  test("runPendingInstallLifecycles delivers runtime.started catch-up when requested", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const { services, counts } = recordingServices()
    let triggered = 0
    let triggeredGeneration: string | undefined
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const results = await runPendingInstallLifecycles({
          plugins: [plugin()],
          services,
          catchUpStarted: true,
          triggerStarted: async ({ generation }) => {
            triggered++
            triggeredGeneration = generation
          },
        })
        expect(results).toEqual([{ status: "completed" }])
      },
    })
    expect(counts()).toEqual({ ensured: 1, invoked: 1 })
    // The injected trigger is only invoked when catchUpStarted is propagated; without
    // propagation this test fails.
    expect(triggered).toBe(1)
    expect(triggeredGeneration).toBe(manifest.artifacts.generation)
  })

  test("boot catch-up does not fire runtime.started (broadcast serves as catch-up)", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    const { services, counts } = recordingServices()
    let triggered = 0
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const results = await runPendingInstallLifecycles({
          plugins: [plugin()],
          services,
          catchUpStarted: false,
          triggerStarted: async () => {
            triggered++
          },
        })
        expect(results).toEqual([{ status: "completed" }])
      },
    })
    expect(counts()).toEqual({ ensured: 1, invoked: 1 })
    expect(triggered).toBe(0)
  })

  test("retry fails loudly when the loaded generation does not match the lockfile", async () => {
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("failed")
    const stale = { ...plugin(), manifest: { ...manifest, artifacts: { ...manifest.artifacts, generation: "other" } } }
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(retryPluginInstallLifecycle(manifest.id, undefined, stale)).rejects.toBeInstanceOf(
          PluginInstallLifecycleGenerationMismatchError,
        )
      },
    })
    // The lockfile entry is left untouched so the user can reinstall/update and retry.
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("failed")
  })

  test("add with a legacy lockfile entry never re-runs the install lifecycle", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginDir = path.join(tmp.path, "legacy-entry")
    const runtimePath = path.join(pluginDir, "runtime", "index.js")
    await Bun.write(runtimePath, `export default {}\n`)
    const legacy = compilePluginManifest(
      definePlugin({
        id: "legacy-entry",
        version: "1.0.0",
        description: "Legacy entry fixture",
        contributions: [lifecycleInstall({ id: "setup", handler: async () => undefined })],
      }),
      {
        generation: "legacy-gen",
        runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
      },
    )
    await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(legacy))
    // Legacy entry: installed before lifecycleInstall tracking existed, so it has no field
    // even though the one-time install hook already ran synchronously at install time.
    await Lockfile.write({
      ...(await Lockfile.read()),
      plugins: {
        "legacy-entry": {
          spec: pathToFileURL(pluginDir).href,
          source: "local",
          version: legacy.version,
          apiVersion: legacy.apiVersion,
          generation: legacy.artifacts.generation,
          resolved: path.join(pluginDir, "plugin.json"),
          manifestHash: "test",
          approvalId: legacy.id,
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const added = await add(pathToFileURL(pluginDir).href, { skipConsent: true, source: "local" })
        // Not fresh: an existing lockfile entry means the one-time hook already ran, so
        // no delivery happens and the field must not be written as pending.
        expect(added.installLifecycle).toBeUndefined()
      },
    })
    const locked = (await Lockfile.read()).plugins["legacy-entry"]
    expect(locked?.lifecycleInstall).not.toBe("pending")
  })

  test("runPendingInstallLifecycles skips entries whose delivery is in flight", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener" })
    await using tmp = await tmpdir({ git: true })
    await seedLockfile("pending")
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { services } = recordingServices()
        services.invoke = async () => {
          await gate
        }
        // Start a delivery that blocks inside the hook; the in-flight claim is registered
        // synchronously, so a concurrent catch-up must skip this entry.
        const delivery = deliverInstallLifecycle(plugin(), { catchUpStarted: false, services })
        const results = await runPendingInstallLifecycles({ plugins: [plugin()], services })
        expect(results).toEqual([])
        release?.()
        await delivery
      },
    })
    const locked = (await Lockfile.read()).plugins[manifest.id]
    expect(locked?.lifecycleInstall).toBe("completed")
  })

  test("retry fails on generation mismatch for an unloaded plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginDir = path.join(tmp.path, "mismatch-unloaded")
    const runtimePath = path.join(pluginDir, "runtime", "index.js")
    await Bun.write(runtimePath, `export default {}\n`)
    const installed = compilePluginManifest(
      definePlugin({
        id: "mismatch-unloaded",
        version: "1.0.0",
        description: "Mismatch fixture",
        contributions: [lifecycleInstall({ id: "setup", handler: async () => undefined })],
      }),
      {
        generation: "installed-gen",
        runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
      },
    )
    await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(installed))
    // Lockfile claims a stale generation that no longer matches the installed manifest.
    await Lockfile.write({
      ...(await Lockfile.read()),
      plugins: {
        "mismatch-unloaded": {
          spec: pathToFileURL(pluginDir).href,
          source: "local",
          version: installed.version,
          apiVersion: installed.apiVersion,
          generation: "stale-gen",
          resolved: path.join(pluginDir, "plugin.json"),
          manifestHash: "test",
          approvalId: installed.id,
          lifecycleInstall: "failed",
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(retryPluginInstallLifecycle("mismatch-unloaded")).rejects.toBeInstanceOf(
          PluginInstallLifecycleGenerationMismatchError,
        )
      },
    })
    // Entry left untouched so reinstall/update can recover.
    const locked = (await Lockfile.read()).plugins["mismatch-unloaded"]
    expect(locked?.lifecycleInstall).toBe("failed")
  })
})
