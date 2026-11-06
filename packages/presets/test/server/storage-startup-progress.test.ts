import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { RuntimeComponents, RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { StorageRecovery } from "@ericsanchezok/synergy-harness/storage/recovery"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import {
  createManagedMigrationReporter,
  createManagedRecoveryReporter,
  createManagedStorageReporter,
  createManagedStartupReporter,
} from "@ericsanchezok/synergy-cli/cli/managed-startup"
import { DesktopServerStartup } from "../../../../apps/desktop/src/server-startup"
import { RUNTIME_STARTUP_PREFIX, RuntimeStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

for (const operation of ["recoverOwners", "load", "reconcileNotifications"] as const) {
  test(`managed startup keeps ${operation} observable after migrations finish`, async () => {
    await using fixture = await runtimeHome()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(fixture.host.root, "agent.sqlite"),
      namespace: "startup",
    })
    let now = 0
    const startup = new DesktopServerStartup({ now: () => now })
    const write = (line: string) => startup.receive(line)
    const original = { ...StorageRecovery }
    let checked = false
    const check = (entry: typeof operation) => {
      if (entry !== operation) return
      checked = true
      now += 31_000
      expect(startup.remainingMs()).toBeGreaterThan(0)
      expect(startup.status().title).toBe("Updating saved data")
      expect(startup.timeoutError().message).not.toContain("health check")
    }
    using owners = spyOn(StorageRecovery, "recoverOwners").mockImplementation((progress) => {
      check("recoverOwners")
      return original.recoverOwners(progress)
    })
    using load = spyOn(StorageRecovery, "load").mockImplementation((progress) => {
      check("load")
      return original.load(progress)
    })
    using notifications = spyOn(StorageRecovery, "reconcileNotifications").mockImplementation((progress) => {
      check("reconcileNotifications")
      return original.reconcileNotifications(progress)
    })
    try {
      await using runtime = await RuntimeHandle.open({
        host: fixture.host,
        storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
        composition: { register() {} },
        mode: "oneshot",
        startupReporter: createManagedStartupReporter(write, () => now),
        reporter: createManagedMigrationReporter(write),
        storageReporter: createManagedStorageReporter(write, () => now),
        recoveryReporter: createManagedRecoveryReporter(write, () => now),
      })
      expect(checked).toBe(true)
      expect(startup.remainingMs()).toBe(30_000)
    } finally {
      await store.close()
    }
  }, 30_000)
}

test("notification recovery reports committed work across long startup, failure and retry", async () => {
  await using fixture = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "agent.sqlite"),
    namespace: "notifications",
  })
  try {
    await store.transaction(async (tx) => {
      for (let index = 0; index < 1300; index++)
        await tx.enqueue({ id: `event-${index}`, scopeID: "fixture", type: "changed", payload: {} })
    })
    const failure = new Error("notification recovery interrupted")
    for (const fails of [true, false]) {
      let now = 0
      let batches = 0
      const records: RuntimeStartupProgress[] = []
      const startup = new DesktopServerStartup({ now: () => now })
      const write = (line: string) => {
        records.push(RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length))))
        startup.receive(line)
      }
      const pendingEvents = store.pendingEvents.bind(store)
      using delayed = spyOn(store, "pendingEvents").mockImplementation(async (limit) => {
        const events = await pendingEvents(limit)
        now += 31_000
        expect(startup.remainingMs()).toBeGreaterThan(0)
        expect(startup.status().detail).toBe("Reconciling saved updates.")
        if (events.length && fails && ++batches === 3) throw failure
        return events
      })
      const opening = RuntimeHandle.open({
        host: fixture.host,
        storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
        composition: { register() {} },
        mode: "oneshot",
        startupReporter: createManagedStartupReporter(write, () => now),
        reporter: createManagedMigrationReporter(write),
        storageReporter: createManagedStorageReporter(write, () => now),
        recoveryReporter: createManagedRecoveryReporter(write, () => now),
      })
      if (fails) {
        await expect(opening).rejects.toBe(failure)
        expect(records.some((record) => record.phase === "storage" && record.stage === "complete")).toBe(false)
        expect(records.findLast((record) => record.phase === "storage")).toMatchObject({
          phase: "storage",
          stage: "notifications",
          current: 200,
        })
        expect(records.at(-1)).toEqual({ phase: "runtime", state: "failed" })
        now += 300_000
        expect(startup.remainingMs()).toBeLessThanOrEqual(0)
        expect(startup.timeoutError().message).toContain("failed during storage-recovery")
      } else {
        await using runtime = await opening
        expect(now).toBeGreaterThan(300_000)
        expect(await pendingEvents()).toEqual([])
        expect(startup.remainingMs()).toBe(30_000)
        expect(records).toContainEqual(
          expect.objectContaining({ phase: "storage", stage: "notifications", current: 1100 }),
        )
        expect(records.at(-1)).toEqual({ phase: "runtime", state: "ready" })
      }
    }
  } finally {
    await store.close()
  }
}, 30_000)

for (const outcome of ["failed", "cancelled"] as const)
  test(`a ${outcome} late startup hook cannot publish readiness and releases its resources for retry`, async () => {
    await using fixture = await runtimeHome()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(fixture.host.root, "agent.sqlite"),
      namespace: "late-startup",
    })
    const storage = {
      kind: "borrowed" as const,
      handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
    }
    const controller = new AbortController()
    const failure = new Error(`startup ${outcome}`)
    const startup = new DesktopServerStartup()
    const records: RuntimeStartupProgress[] = []
    const write = (line: string) => {
      records.push(RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length))))
      startup.receive(line)
    }
    let server: ReturnType<typeof Bun.serve> | undefined
    let stopped = false
    let disposed = false
    try {
      await expect(
        RuntimeHandle.open({
          host: fixture.host,
          storage,
          mode: "server",
          signal: controller.signal,
          startupReporter: createManagedStartupReporter(write),
          recoveryReporter: createManagedRecoveryReporter(write),
          composition: {
            register() {},
            services: () => ({
              async disposeExtensions() {
                disposed = true
              },
              transport: {
                closeAdmission() {},
                listen() {
                  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ healthy: true }) })
                  return {
                    hostname: server.hostname,
                    port: server.port,
                    async stop() {
                      await server!.stop(true)
                      stopped = true
                    },
                  }
                },
              },
              async started() {
                expect((await fetch(server!.url)).ok).toBe(true)
                expect(startup.isReady()).toBe(false)
                expect(startup.status().detail).toBe("Finishing runtime startup.")
                if (outcome === "failed") throw failure
                controller.abort(failure)
              },
            }),
          },
        }),
      ).rejects.toBe(failure)
      expect(records.some((event) => event.phase === "runtime" && event.state === "ready")).toBe(false)
      expect(records.at(-1)).toEqual({ phase: "runtime", state: "failed" })
      expect(startup.remainingMs()).toBe(0)
      expect(stopped).toBe(true)
      expect(disposed).toBe(true)
      await using retry = await RuntimeHandle.open({
        host: fixture.host,
        storage,
        mode: "oneshot",
        composition: { register() {} },
      })
      expect(retry.status).toBe("ready")
    } finally {
      await server?.stop(true)
      await store.close()
    }
  }, 30_000)

test("component startup work remains observable beyond the inactivity budget without component instrumentation", async () => {
  await using fixture = await runtimeHome()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(fixture.host.root, "agent.sqlite"),
    namespace: "components",
  })
  let now = 0
  const startup = new DesktopServerStartup({ now: () => now })
  const write = (line: string) => startup.receive(line)
  const slow = (detail: string) => {
    now += 31_000
    expect(startup.isReady()).toBe(false)
    expect(startup.status().detail).toBe(detail)
    expect(startup.remainingMs()).toBeGreaterThan(0)
  }
  try {
    await using runtime = await RuntimeHandle.open({
      host: fixture.host,
      storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
      mode: "server",
      startupReporter: createManagedStartupReporter(write, () => now),
      reporter: createManagedMigrationReporter(write),
      storageReporter: createManagedStorageReporter(write, () => now),
      recoveryReporter: createManagedRecoveryReporter(write, () => now),
      composition: RuntimeComponents.compose(
        Array.from({ length: 12 }, (_, index) => ({
          id: `fixture-${index}`,
          apiVersion: 1,
          version: "local",
          register() {},
          services: () => ({
            async initializeExtensions() {
              slow("Initializing extensions.")
            },
            resident: {
              async start() {
                slow("Starting background services.")
              },
              async ready() {
                slow("Starting background services.")
              },
              async stop() {},
            },
            async started() {
              slow("Finishing runtime startup.")
            },
          }),
        })),
      ),
    })
    expect(now).toBeGreaterThan(300_000)
    expect(startup.isReady()).toBe(true)
    expect(startup.remainingMs()).toBe(30_000)
  } finally {
    await store.close()
  }
}, 30_000)
