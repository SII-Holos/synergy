import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { PluginRuntimeManager, type PluginRuntimeManagerDependencies } from "../../src/plugin-runtime/manager"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"
import { startMemoryMonitor } from "../../src/plugin-runtime/resource-limits"
import { pluginAgentCallRuntime, type PluginAgentCallTerminal } from "../../src/plugin-runtime/agent-call-runtime"
import { testRuntime } from "../support/runtime"
import { startupInstallation } from "./fixtures/startup-installation"
import { prepareActivation } from "./fixtures/startup-in-process-plugin"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const launcher = fileURLToPath(new URL("../../../cli/src/launcher.ts", import.meta.url))
const worker = fileURLToPath(new URL("./fixtures/startup-worker.ts", import.meta.url))
const manifest = compilePluginManifest(
  definePlugin({
    id: "startup-fixture",
    version: "1.0.0",
    description: "Plugin startup lifecycle fixture",
    contributions: [],
  }),
  { generation: "startup-test", runtime: { entry: "plugin.ts", sha256: "test" } },
)

async function fixture(options: Partial<PluginRuntimeManagerDependencies> = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-startup-"))
  const environment: Record<string, string | undefined> = {
    SYNERGY_HOME: home,
    SYNERGY_RUNTIME_ROOT: home,
    SYNERGY_INSTALLATION_ROOT: home,
    SYNERGY_INSTALLATION_PIN: JSON.stringify({ id: crypto.randomUUID(), sha256: "a".repeat(64) }),
    SYNERGY_LAUNCHER_COMMAND: JSON.stringify([process.execPath, worker]),
    SYNERGY_LAUNCHER_CONTROL_VERSION: "1",
    SYNERGY_WORKER_CONTROL_VERSION: "inherited-request-must-not-leak",
    SYNERGY_TEST_STARTUP_SCENARIO: "missing",
  }
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
  function restoreEnvironment() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const monitors: Array<{ stopped: boolean; pid: number }> = []
  const manager = new PluginRuntimeManager(undefined, {
    bootstrapTimeoutMs: 300,
    startMemoryMonitor(input) {
      const record = { stopped: false, pid: input.pid }
      monitors.push(record)
      const monitor = startMemoryMonitor(input)
      return {
        stop() {
          record.stopped = true
          monitor.stop()
        },
      }
    },
    ...options,
  })
  const children: Bun.Subprocess[] = []
  const starts: Promise<unknown>[] = []
  function start(startupTimeoutMs = 150, entryPath = path.join(home, "plugin.ts")) {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const promise = (() => {
      try {
        return manager.start({
          manifest,
          pluginDir: home,
          entryPath,
          limits: { ...DEFAULT_LIMITS, startupTimeoutMs, shutdownGraceMs: 30, memorySampleIntervalMs: 60_000 },
        })
      } finally {
        restoreEnvironment()
      }
    })()
    const entry = manager.registry.list()[0]!
    if (entry?.process) children.push(entry.process.process)
    const outcome = promise.then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error: error as Error }),
    )
    starts.push(outcome)
    return { promise, outcome, entry }
  }
  return {
    home,
    env: environment,
    manager,
    monitors,
    start,
    async [Symbol.asyncDispose]() {
      for (const entry of manager.registry.list()) await manager.stopGeneration(entry.key, 0)
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
      await Promise.allSettled(starts)
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 2000
  while (!predicate() && performance.now() < deadline) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}

function gates() {
  const bootstrap = Promise.withResolvers<Response>()
  const activation = Promise.withResolvers<Response>()
  const entered = { bootstrap: Promise.withResolvers<void>(), activation: Promise.withResolvers<void>() }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const phase = new URL(request.url).pathname === "/bootstrap" ? "bootstrap" : "activation"
      entered[phase].resolve()
      return phase === "bootstrap" ? bootstrap.promise : activation.promise
    },
  })
  return {
    entered,
    bootstrapURL: new URL("/bootstrap", server.url).href,
    activationURL: new URL("/activation", server.url).href,
    releaseBootstrap() {
      bootstrap.resolve(new Response("initialized"))
    },
    releaseActivation() {
      activation.resolve(new Response("activated"))
    },
    [Symbol.dispose]() {
      bootstrap.resolve(new Response())
      activation.resolve(new Response())
      server.stop(true)
    },
  }
}

for (const startupTimeoutMs of [150, DEFAULT_LIMITS.startupTimeoutMs]) {
  test(
    `installed host initialization can exceed the ${startupTimeoutMs}ms activation budget`,
    () =>
      runtime.run(async () => {
        await using scope = await fixture({ bootstrapTimeoutMs: 15_000 })
        using gate = gates()
        const installed = await startupInstallation(scope.home, gate.bootstrapURL, gate.activationURL)
        scope.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({
          id: installed.generation.id,
          sha256: installed.generation.sha256,
        })
        scope.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([process.execPath, launcher])
        gate.releaseActivation()
        const started = scope.start(startupTimeoutMs, installed.entryPath)
        await Promise.race([gate.entered.bootstrap.promise, started.promise])
        await Bun.sleep(startupTimeoutMs + 50)
        gate.releaseBootstrap()
        const result = await started.outcome
        expect(result.error).toBeUndefined()
        expect(result.value?.state).toBe("ready")
        expect(await Bun.file(path.join(scope.home, "activations")).text()).toBe("activate\n")
      }),
    20_000,
  )
}

test("fast installed bootstrap does not extend slow plugin activation", () =>
  runtime.run(async () => {
    await using scope = await fixture({ bootstrapTimeoutMs: 2000 })
    using gate = gates()
    const installed = await startupInstallation(scope.home, gate.bootstrapURL, gate.activationURL)
    scope.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({
      id: installed.generation.id,
      sha256: installed.generation.sha256,
    })
    scope.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([process.execPath, launcher])
    gate.releaseBootstrap()
    const started = scope.start(300, installed.entryPath)
    await Promise.race([gate.entered.activation.promise, started.promise])
    expect((await started.outcome).error?.message).toContain("startup timed out after 300ms")
    expect(scope.manager.registry.list()).toEqual([])
    expect(scope.monitors.every((monitor) => monitor.stopped)).toBe(true)
    expect(started.entry.process?.process.exitCode).not.toBeNull()
  }))

test("generation tampering fails before a plugin entry side effect or activation", () =>
  runtime.run(async () => {
    await using scope = await fixture()
    using gate = gates()
    const installed = await startupInstallation(scope.home, gate.bootstrapURL, gate.activationURL)
    await installed.tamper()
    scope.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({
      id: installed.generation.id,
      sha256: installed.generation.sha256,
    })
    scope.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([process.execPath, launcher])
    gate.releaseBootstrap()
    gate.releaseActivation()
    const started = scope.start()
    expect((await started.outcome).error?.message).toContain("exited")
    expect(await Bun.file(path.join(scope.home, "entry")).exists()).toBe(false)
    expect(scope.manager.registry.list()).toEqual([])
  }))

for (const scenario of [
  "wrong-pin",
  "wrong-digest",
  "wrong-version",
  "wrong-runner",
  "malformed",
  "malformed-json",
  "wrong-discriminator",
  "premature",
  "missing",
  "exit",
]) {
  test(`installed startup fails closed for ${scenario}`, () =>
    runtime.run(async () => {
      await using scope = await fixture()
      scope.env.SYNERGY_TEST_STARTUP_SCENARIO = scenario
      const started = scope.start(1500)
      const result = await started.outcome
      expect(result.error?.message).toMatch(
        scenario === "missing"
          ? /bootstrap timed out after 300ms/
          : scenario === "exit"
            ? /exited \(0\)/
            : /launcher|before activation/,
      )
      expect(scope.manager.registry.list()).toEqual([])
      expect(scope.monitors.every((monitor) => monitor.stopped)).toBe(true)
      expect(started.entry.process?.process.exitCode).not.toBeNull()
      expect(scope.manager.logs.list(manifest.id).filter((log) => log.message.startsWith("activations:"))).toEqual([])
    }))
}

test("duplicate launcher frames activate once and concurrent starts remain shared", () =>
  runtime.run(async () => {
    await using scope = await fixture()
    scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "duplicate"
    const first = scope.start(1000)
    const second = scope.start(1000)
    const entries = await Promise.all([first.promise, second.promise])
    expect(entries[0]).toBe(entries[1])
    expect(scope.monitors).toHaveLength(1)
    await waitFor(() => scope.manager.logs.list(manifest.id).some((log) => log.message === "activations:1"))
    expect(scope.manager.logs.list(manifest.id).filter((log) => log.message.startsWith("activations:"))).toHaveLength(1)
    expect(scope.manager.logs.list(manifest.id).some((log) => log.message === "control:1")).toBe(true)
  }))

test("duplicate frames do not renew the activation deadline", () =>
  runtime.run(async () => {
    let now = 0
    await using scope = await fixture({ monotonicNow: () => now })
    scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "duplicate-timeout"
    const started = scope.start(1000)
    await waitFor(() => scope.manager.logs.list(manifest.id).some((log) => log.message === "activations:1"))
    now = 999
    started.entry.process?.send({ type: "ping" })
    await waitFor(() => scope.manager.logs.list(manifest.id).some((log) => log.message === "frame-sent"))
    now = 1001
    started.entry.process?.send({ type: "ping" })
    expect((await started.outcome).error?.message).toContain("startup timed out after 1000ms")
    expect(scope.manager.registry.list()).toEqual([])
  }))

for (const phase of ["bootstrap", "activation"] as const) {
  test(`a late ${phase} event cannot beat the monotonic deadline`, () =>
    runtime.run(async () => {
      let now = 0
      await using scope = await fixture({ bootstrapTimeoutMs: 1000, monotonicNow: () => now })
      scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "controlled"
      const started = scope.start(1000)
      await waitFor(() => scope.manager.logs.list(manifest.id).some((log) => log.message === "control:1"))
      if (phase === "activation") {
        started.entry.process?.send({ type: "ping" })
        await waitFor(() => scope.manager.logs.list(manifest.id).some((log) => log.message === "activations:1"))
      }
      now = 1001
      started.entry.process?.send({ type: "ping" })
      expect((await started.outcome).error?.message).toContain(
        `${phase === "bootstrap" ? "bootstrap" : "startup"} timed out after 1000ms`,
      )
      expect(scope.manager.registry.list()).toEqual([])
    }))
}

for (const method of ["stop", "stopGeneration"] as const) {
  test(`owner ${method} settles a starting runtime despite late frames`, () =>
    runtime.run(async () => {
      await using scope = await fixture({ bootstrapTimeoutMs: 2000 })
      scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "late"
      const started = scope.start(2000)
      await waitFor(() => scope.manager.logs.list(manifest.id).length > 0)
      await scope.manager[method](method === "stop" ? manifest.id : started.entry.key, 30)
      expect((await started.outcome).error?.message).toContain("stopped")
      expect(scope.manager.registry.list()).toEqual([])
      expect(started.entry.state).toBe("stopped")
      expect(started.entry.process?.process.exitCode).not.toBeNull()
      expect(scope.monitors.every((monitor) => monitor.stopped)).toBe(true)
    }))
}

for (const termination of ["failure", "stop", "stopGeneration"] as const) {
  test(`terminal Agent call delivery cannot reenter a source startup during ${termination} cleanup`, () =>
    runtime.run(async () => {
      await using scope = await fixture()
      scope.env.SYNERGY_INSTALLATION_PIN = undefined
      scope.env.SYNERGY_LAUNCHER_COMMAND = undefined
      const calls = pluginAgentCallRuntime()
      const delivered: PluginAgentCallTerminal[] = []
      const releaseDelivery = Promise.withResolvers<void>()
      let reentrySettled = false
      let reentryError: unknown
      let callSignal: AbortSignal | undefined
      calls.start({
        pluginId: manifest.id,
        pluginGeneration: manifest.artifacts.generation,
        scopeId: "startup-delivery",
        correlationId: termination,
        inputDigest: termination,
        run(signal) {
          callSignal = signal
          return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason)
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        },
        async deliver(call) {
          delivered.push(call)
          const reentry = scope.start(2000)
          await Promise.race([
            reentry.outcome.then((result) => {
              reentryError = result.error
              reentrySettled = true
            }),
            releaseDelivery.promise,
          ])
          await releaseDelivery.promise
        },
        mapError: () => ({ code: "CANCELLED", message: "Agent call cancelled" }),
      })
      const started = scope.start(2000)
      let startupSettled = false
      void started.outcome.then(() => {
        startupSettled = true
      })
      const stopping =
        termination === "failure"
          ? undefined
          : scope.manager[termination](termination === "stop" ? manifest.id : started.entry.key, 30)
      try {
        await waitFor(() => reentrySettled)
        expect(reentryError).toMatchObject({ code: "PLUGIN_UNAVAILABLE" })
        expect(startupSettled).toBe(false)
        expect(scope.manager.registry.get(started.entry.key)).toBe(started.entry)
        expect(started.entry.state).toBe(termination === "failure" ? "crashed" : "stopped")
        expect(scope.monitors).toHaveLength(1)
        expect(scope.monitors[0].stopped).toBe(true)
        await expect(scope.start(2000).promise).rejects.toMatchObject({ code: "PLUGIN_UNAVAILABLE" })
      } finally {
        releaseDelivery.resolve()
        await started.outcome
        await stopping
      }
      const result = await started.outcome
      expect(result.error?.message).toContain(termination === "failure" ? "exited (1)" : "stopped")
      expect(startupSettled).toBe(true)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ status: "cancelled", error: { code: "PLUGIN_AGENT_CANCELLED" } })
      expect(callSignal?.aborted).toBe(true)
      expect(calls.activeCount(manifest.id)).toBe(0)
      expect(started.entry.memoryMonitor).toBeUndefined()
      expect(started.entry.process?.process.exitCode).not.toBeNull()
      expect(() => process.kill(started.entry.process!.process.pid, 0)).toThrow()
      expect(scope.manager.registry.list()).toEqual([])
      expect(scope.manager.resourceStats().processCount).toBe(0)

      await Bun.write(
        path.join(scope.home, "plugin.ts"),
        'export default { id: "startup-fixture", version: "1.0.0", handlerIds: [], contributions: [] }',
      )
      const retried = await scope.start(2000).promise
      expect(retried).not.toBe(started.entry)
      expect(retried.state).toBe("ready")
      expect(scope.manager.registry.active(manifest.id)).toBe(retried)
      expect(scope.monitors).toHaveLength(2)
      expect(delivered).toHaveLength(1)
    }))
}

for (const method of ["stop", "stopGeneration"] as const) {
  test(`trusted inProcess ${method} does not join pending activation`, () =>
    runtime.run(async () => {
      const activation = prepareActivation()
      const manager = new PluginRuntimeManager()
      const entryPath = fileURLToPath(new URL("./fixtures/startup-in-process-plugin.ts", import.meta.url))
      const starting = manager.start({
        manifest,
        pluginDir: path.dirname(entryPath),
        entryPath,
        mode: "inProcess",
        trustedBuiltin: true,
        limits: DEFAULT_LIMITS,
      })
      const outcome = starting.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error: error as Error }),
      )
      await Promise.race([activation.entered.promise, starting])
      const entry = manager.registry.list()[0]!
      let stopped = false
      const stopping = manager[method](method === "stop" ? manifest.id : entry.key).then(() => {
        stopped = true
      })
      try {
        await waitFor(() => stopped)
        if (method === "stopGeneration") {
          expect(activation.events).toEqual(["activate:entered", "deactivate"])
          expect(manager.registry.list()).toEqual([])
          const failure = new Error("Activation failed before allocating resources")
          activation.release.reject(failure)
          expect((await outcome).error).toBe(failure)
          expect(activation.events).toEqual(["activate:entered", "deactivate"])
          expect(activation.server).toBeUndefined()
          return
        }

        expect(activation.events).toEqual(["activate:entered"])
        expect(manager.registry.get(entry.key)).toBe(entry)
        expect(entry.state).toBe("starting")
        expect(manager.registry.active(manifest.id)).toBeUndefined()
        activation.release.resolve()
        expect((await outcome).error).toBeUndefined()
        expect(entry.state).toBe("ready")
        expect(manager.registry.active(manifest.id)).toBe(entry)
        const url = activation.server!.url
        expect(await (await fetch(url)).text()).toBe("active")
        await manager.stop(manifest.id)
        expect(activation.events).toEqual(["activate:entered", "activate:allocated", "deactivate"])
        expect(activation.server).toBeUndefined()
        expect(manager.registry.list()).toEqual([])
        await expect(fetch(url)).rejects.toThrow()
      } finally {
        activation.release.resolve()
        await outcome
        await stopping
        await manager.stop(manifest.id)
        await activation.server?.stop(true)
      }
    }))
}

for (const support of [undefined, "0", "2"]) {
  test(`legacy or unsupported launcher (${support ?? "absent"}) keeps spawn-to-ready startup`, () =>
    runtime.run(async () => {
      await using scope = await fixture()
      scope.env.SYNERGY_LAUNCHER_CONTROL_VERSION = support
      scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "controlled"
      const started = scope.start(100)
      expect((await started.outcome).error?.message).toContain("startup timed out after 100ms")
      expect(scope.manager.logs.list(manifest.id).some((log) => log.message === "control:none")).toBe(true)
      expect(scope.manager.registry.list()).toEqual([])
    }))
}

test("spawn and monitor exceptions remove failed ownership and permit a retry", () =>
  runtime.run(async () => {
    await using scope = await fixture({
      startMemoryMonitor() {
        throw new Error("monitor startup failed")
      },
    })
    scope.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([path.join(scope.home, "missing-launcher")])
    expect((await scope.start().outcome).error).toBeDefined()
    expect(scope.manager.registry.list()).toEqual([])
    scope.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify([process.execPath, worker])
    const started = scope.start()
    expect((await started.outcome).error?.message).toBe("monitor startup failed")
    expect(scope.manager.registry.list()).toEqual([])
    expect(started.entry.process?.process.exitCode).not.toBeNull()
  }))

test("the default installed bootstrap deadline is an absolute 300000ms", () =>
  runtime.run(async () => {
    let now = 0
    await using scope = await fixture({ bootstrapTimeoutMs: undefined, monotonicNow: () => now })
    scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "controlled"
    const started = scope.start()
    await waitFor(() => scope.manager.logs.list(manifest.id).some((log) => log.message === "control:1"))
    now = 300_000
    started.entry.process?.send({ type: "ping" })
    expect((await started.outcome).error?.message).toContain("bootstrap timed out after 300000ms")
    expect(scope.manager.registry.list()).toEqual([])
  }))

test("a plugin ready sent during timeout cleanup cannot resurrect the generation", () =>
  runtime.run(async () => {
    await using scope = await fixture()
    scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "late-ready"
    const started = scope.start(100)
    expect((await started.outcome).error?.message).toContain("startup timed out after 100ms")
    expect(started.entry.state).toBe("crashed")
    expect(scope.manager.registry.list()).toEqual([])
    expect(started.entry.process?.process.exitCode).not.toBeNull()
  }))

test("startup cleanup awaits a child that ignores graceful shutdown", () =>
  runtime.run(async () => {
    await using scope = await fixture()
    scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "ignore-shutdown"
    const started = scope.start()
    await waitFor(() => scope.manager.logs.list(manifest.id).length > 0)
    await Promise.all([scope.manager.stop(manifest.id, 10), scope.manager.stopGeneration(started.entry.key, 10)])
    expect((await started.outcome).error?.message).toContain("stopped")
    expect(started.entry.process?.process.signalCode).toBe("SIGKILL")
    expect(() => process.kill(started.entry.process!.process.pid, 0)).toThrow()
    expect(scope.manager.registry.list()).toEqual([])
  }))

test("failed old-owner cleanup cannot delete a replacement registry entry", () =>
  runtime.run(async () => {
    await using scope = await fixture()
    scope.env.SYNERGY_TEST_STARTUP_SCENARIO = "ignore-shutdown"
    const started = scope.start()
    await waitFor(() => scope.manager.logs.list(manifest.id).length > 0)
    const stopping = scope.manager.stopGeneration(started.entry.key, 30)
    const successor = { ...started.entry, process: undefined, memoryMonitor: undefined, state: "ready" as const }
    scope.manager.registry.set(successor)
    await stopping
    expect((await started.outcome).error?.message).toContain("stopped")
    expect(scope.manager.registry.get(successor.key)).toBe(successor)
  }))

test("source runners keep their original spawn-to-ready timeout even with launcher metadata", () =>
  runtime.run(async () => {
    await using scope = await fixture()
    using gate = gates()
    const installed = await startupInstallation(scope.home, gate.bootstrapURL, gate.activationURL)
    scope.env.SYNERGY_INSTALLATION_PIN = undefined
    scope.env.SYNERGY_LAUNCHER_COMMAND = undefined
    const started = scope.start(300, installed.entryPath)
    await Promise.race([gate.entered.activation.promise, started.promise])
    expect((await started.outcome).error?.message).toContain("startup timed out after 300ms")
    expect(await Bun.file(path.join(scope.home, "entry")).exists()).toBe(true)
    expect(scope.manager.registry.list()).toEqual([])
  }))

for (const mismatch of ["protocol", "generation", "handlers"]) {
  test(`plugin ready still checks ${mismatch} after the launcher handoff`, () =>
    runtime.run(async () => {
      await using scope = await fixture()
      scope.env.SYNERGY_TEST_STARTUP_SCENARIO = `wrong-${mismatch}`
      const started = scope.start()
      expect((await started.outcome).error?.message).toContain(`Plugin runtime ${mismatch}`)
      expect(scope.manager.registry.list()).toEqual([])
    }))
}
