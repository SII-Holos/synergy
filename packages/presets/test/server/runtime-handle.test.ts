import { Experiment } from "@ericsanchezok/synergy-harness/config/experiment"
import { resolveAgentWorkerCapacity } from "@ericsanchezok/synergy-harness/execution/execution-config"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { expect, test } from "bun:test"
import path from "node:path"
import { PresetRuntimeHandle } from "../../src"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

test("one-shot owns its Home, omits autonomous recovery, and awaits idempotent shutdown", async () => {
  await using fixture = await runtimeHome()
  const recovery: Array<number | "completed"> = []
  await using runtime = await PresetRuntimeHandle.open({
    host: fixture.host,
    mode: "oneshot",
    network: { hostname: "127.0.0.1", port: 0 },
    recoveryReporter: { progress: (current) => recovery.push(current), completed: () => recovery.push("completed") },
  })
  const events = runtime.run(() => GlobalBus())
  expect(runtime.components.some((component) => component.id === "web-app")).toBe(false)
  expect((await Bun.file(path.join(fixture.host.root, "schema/config.schema.json")).json()).properties).toHaveProperty(
    "lsp",
  )
  expect(recovery[0]).toBe(0)
  expect(recovery.at(-1)).toBe("completed")
  expect((await runtime.run(() => ServerProcessLock.read()))?.mode).toBe("oneshot")
  expect(runtime.run(() => ScopeStartup.resident())).toBe(false)
  const capacity = resolveAgentWorkerCapacity({}, "oneshot")
  expect(runtime.config.execution?.agentWorkers).toBe(capacity.size)
  expect(runtime.config.execution?.agentWorkerMinIdle).toBe(0)
  expect(() =>
    runtime.run(() => Experiment.assertRuntime({ execution: { agentWorkers: capacity.size } })),
  ).not.toThrow()
  await expect(PresetRuntimeHandle.open({ host: fixture.host, mode: "oneshot" })).rejects.toThrow("already owns")
  const response = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
  expect(response.ok).toBe(true)
  await Promise.all([runtime.close(), runtime.close()])
  expect(await RuntimeContext.create(fixture.host).run(() => ServerProcessLock.read())).toBeUndefined()
  expect(events.listenerCount("event")).toBe(0)
}, 30_000)

test("embedding the full backend serves only an explicitly selected Web application", async () => {
  await using fixture = await runtimeHome()
  const directory = path.join(fixture.host.root, "company-app")
  await Bun.write(path.join(directory, "index.html"), "<!doctype html><html><body>Company UI fixture</body></html>")
  await using runtime = await PresetRuntimeHandle.open({
    host: fixture.host,
    mode: "server",
    network: { hostname: "127.0.0.1", port: 0 },
    webAppDirectory: directory,
  })
  expect(runtime.components.some((component) => component.id === "web-app")).toBe(true)
  const response = await fetch(`http://127.0.0.1:${runtime.server.port}/`)
  expect(await response.text()).toContain("Company UI fixture")
}, 30_000)

test("failed recovery does not announce completion or retain home ownership", async () => {
  await using fixture = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "borrowed.sqlite"),
    namespace: "borrowed",
  })
  const root = ["operations", "test", crypto.randomUUID(), "rollout", "journal"]
  const recovery: Array<number | "completed"> = []
  try {
    await store.transaction(async (tx) => {
      await tx.write([...root, "head"], { allocated: 1, committed: 1 })
      await tx.write([...root, "events", "000000000001"], { version: 1, seq: 2, time: 0, kind: "gap" })
    })
    await expect(
      PresetRuntimeHandle.open({
        host: fixture.host,
        mode: "oneshot",
        storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
        recoveryReporter: {
          progress: (current) => recovery.push(current),
          completed: () => recovery.push("completed"),
        },
      }),
    ).rejects.toThrow()
    expect(recovery[0]).toBe(0)
    expect(recovery).not.toContain("completed")
    expect(await RuntimeContext.create(fixture.host).run(() => ServerProcessLock.read())).toBeUndefined()
  } finally {
    await store.close()
  }
}, 30_000)
