import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { expect, test } from "bun:test"
import path from "node:path"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { workerPlan, registerWorkerComponents } from "@ericsanchezok/synergy-agent-runtime/workers"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Features } from "@ericsanchezok/synergy-harness/lifecycle/features"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tools"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { readFeaturePreferences } from "@ericsanchezok/synergy-util/feature-config"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "../../src/components"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { LatticeTypes } from "@ericsanchezok/synergy-lattice/lattice/types"
import { DataTransfer } from "../../src/cli/data/transfer"

const candidates = () => [localRuntime({ workers: false, environment: false }), plugins(), ...fullComponents()]

test("default feature plan retains stable owners and excludes experimental modules and bridges", () => {
  const components = candidates()
  expect(components.every((component) => component.features)).toBe(true)
  const plan = FeatureSelection.resolve(components)
  for (const id of ["boss", "lattice", "boss-feishu", "channel-lattice"]) expect(plan.components).not.toContain(id)
  for (const id of ["workbench", "data-management", "blueprint", "agenda", "channel-feishu", "library"])
    expect(plan.components).toContain(id)
  expect(
    plan.definitions
      .filter((item) => item.maturity === "experimental")
      .map((item) => item.id)
      .sort(),
  ).toEqual(["boss", "kanban", "lattice"])
})

test("fresh and upgraded homes default off; saved choices apply only after restart and preserve dormant data", async () => {
  await using home = await runtimeHome()
  const root = path.join(home.host.root, "config")
  const business = path.join(root, "synergy.d/120-runtime.jsonc")
  await Bun.write(business, JSON.stringify({ boss: { enabled: true, identityText: "preserved" } }))
  const open = () =>
    openAgentRuntime({ home: home.host.root, host: home.host, components: candidates(), listen: false })
  const runtime = await open()
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          expect(Features.enabled("boss")).toBe(false)
          expect(Features.enabled("lattice")).toBe(false)
          expect(Features.enabled("kanban")).toBe(false)
          expect((await Agent.list()).map((agent) => agent.name)).not.toContain("boss-synergy")
          expect(await ToolRegistry.ids()).not.toContain("boss_assign")
          expect(WorkflowKindRegistry.get("lattice")).toBeUndefined()
          expect((await Server.App().request("/boss")).status).toBe(404)
          const capabilities = await (await Server.App().request("/global/capabilities")).json()
          expect(capabilities.features).toContain("workbench")
          expect(capabilities.features).toContain("blueprint")
          expect(capabilities.features).not.toContain("kanban")
          await Storage.write(["fixture", "dormant-lattice"], { retained: "history" })
          const response = await Server.App().request("/config/domains/features", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: { features: { optIn: ["boss", "lattice", "kanban"] } } }),
          })
          expect(response.status).toBe(200)
          const catalog = await (await Server.App().request("/global/features")).json()
          expect(catalog.find((item: { id: string }) => item.id === "boss")).toMatchObject({
            selected: true,
            enabled: false,
            pendingRestart: true,
          })
          expect(Features.enabled("boss")).toBe(false)
        },
      }),
    )
  } finally {
    await runtime.close()
  }
  const active = await open()
  try {
    await active.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          for (const id of ["boss", "lattice", "kanban"]) expect(Features.enabled(id)).toBe(true)
          expect((await Config.global()).boss).toMatchObject({ enabled: true, identityText: "preserved" })
          expect(await Storage.read(["fixture", "dormant-lattice"])).toEqual({ retained: "history" })
          expect(await ToolRegistry.ids()).toContain("boss_assign")
          expect(Server.features()).toContain("kanban")
          await Config.domainUpdate("features", { features: { optIn: [] } })
        },
      }),
    )
  } finally {
    await active.close()
  }
  const disabled = await open()
  try {
    await disabled.run(async () => {
      expect(Features.enabled("boss")).toBe(false)
      expect(await Storage.read(["fixture", "dormant-lattice"])).toEqual({ retained: "history" })
      await Config.domainUpdate("runtime", { compaction: { auto: false } })
      expect((await Bun.file(business).json()).boss).toMatchObject({ enabled: true, identityText: "preserved" })
    })
  } finally {
    await disabled.close()
  }
}, 60_000)

test("worker uses the pinned feature plan even after on-disk choices change", async () => {
  await using home = await runtimeHome()
  const all = candidates()
  const plan = FeatureSelection.resolve(all)
  const selected = all.filter((component) => plan.components.includes(component.id))
  await Bun.write(
    path.join(home.host.root, "config/synergy.d/140-features.jsonc"),
    JSON.stringify({ features: { optIn: ["boss", "lattice"] } }),
  )
  expect((await readFeaturePreferences(path.join(home.host.root, "config"))).optIn).toContain("boss")
  const runtime = RuntimeContext.create({
    ...home.host,
    env: { ...home.host.env, SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(selected, plan)) },
  })
  try {
    await runtime.run(async () => {
      await registerWorkerComponents("agent")
      expect(RuntimeComponents.selected().map((component) => component.id)).not.toContain("boss")
      expect(Features.enabled("boss")).toBe(false)
      expect(Features.enabled("lattice")).toBe(false)
    })
  } finally {
    runtime.dispose()
  }
})

test("source worker bootstrap does not re-read mutable feature preferences", async () => {
  await using home = await runtimeHome()
  const components = [localRuntime({ workers: false, environment: false })]
  await Bun.write(path.join(home.host.root, "config/synergy.d/140-features.jsonc"), "{invalid")
  const ready = Promise.withResolvers<void>()
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../../src/index.ts"), "__agent-turn-runner"], {
    env: {
      ...home.host.env,
      SYNERGY_WORKER_COMPONENTS: JSON.stringify(workerPlan(components, FeatureSelection.resolve(components))),
    },
    stdout: "ignore",
    stderr: "pipe",
    ipc(message: unknown) {
      if (message && typeof message === "object" && "type" in message && message.type === "ready") ready.resolve()
    },
  })
  const error = new Response(child.stderr).text()
  const timeout = setTimeout(() => ready.reject(new Error("Worker readiness timeout")), 10_000)
  void child.exited.then(async (code) => ready.reject(new Error(`Worker exited ${code}: ${await error}`)))
  try {
    await ready.promise
    expect(child.exitCode).toBeNull()
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
  }
}, 15_000)

test("offline Home maintenance upgrades dormant Lattice data without enabling its runtime", async () => {
  await using home = await runtimeHome()
  const all = candidates()
  const runtime = await openAgentRuntime({
    home: home.host.root,
    host: home.host,
    components: all,
    features: FeatureSelection.resolve(all, { optIn: ["lattice"] }),
    listen: false,
  })
  let retained!: LatticeTypes.Run
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ title: "Dormant Lattice history" })
          retained = LatticeTypes.Run.parse({
            schemaVersion: 2,
            id: Identifier.ascending("lattice_run"),
            scopeID: "home",
            sessionID: session.id,
            mode: "collaborative",
            maxModelCalls: 0,
            modelCallCount: 0,
            status: "active",
            state: "clarifying",
            revision: 0,
            stateRevision: 0,
            pathwayRevision: 0,
            pathway: [],
            time: { created: 1, updated: 1 },
          })
          await Storage.write(StoragePath.latticeRun(Identifier.asScopeID("home"), retained.id), retained)
          await Storage.write(["sessions", "home", session.id, "info"], {
            ...session,
            workflow: { kind: "lattice", runID: retained.id, mode: "collaborative" },
          })
          await Storage.write(StoragePath.metaMigrationLogDomain("lattice"), {})
        },
      }),
    )
  } finally {
    await runtime.close()
  }
  const context = RuntimeContext.create(home.host)
  try {
    await context.run(async () => {
      await using locks = await DataTransfer.lockHomes([home.host.root])
      const data = (await StorageBootstrap.inspect(home.host.root))!
      try {
        expect(await data.store.read(StoragePath.latticeRun(Identifier.asScopeID("home"), retained.id))).toEqual(
          retained,
        )
        const receipt = await data.store.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("lattice"))
        expect(receipt?.["20260722-lattice-v2-reset"]).toBeGreaterThan(0)
      } finally {
        await data.store.close()
      }
    })
  } finally {
    await context.run(async () => {
      ObservabilityMetrics.stop()
      await ObservabilityStore.stop()
    })
    context.dispose()
  }
  await using dormant = await openAgentRuntime({
    home: home.host.root,
    host: home.host,
    components: all,
    listen: false,
  })
  await dormant.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect(Features.enabled("lattice")).toBe(false)
        expect(WorkflowKindRegistry.get("lattice")).toBeUndefined()
        expect((await Session.get(retained.sessionID)).title).toBe("Dormant Lattice history")
        expect(await Storage.read(StoragePath.latticeRun(Identifier.asScopeID("home"), retained.id))).toEqual(retained)
      },
    }),
  )
}, 60_000)
