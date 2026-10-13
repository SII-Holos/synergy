import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { AgendaStore } from "../../src/agenda/store"
import { AgendaReactor } from "../../src/agenda/reactor"
import { testRuntime } from "../support/runtime"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { AgendaTypes } from "../../src/agenda/types"
import { migrations } from "../../src/agenda/migration"
import { AgendaWatcher } from "../../src/agenda/watcher"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { fn } from "@ericsanchezok/synergy-harness/util/fn"
import { AgendaDedup } from "../../src/agenda/dedup"

const invokeSchema = SessionInvoke.invoke.schema

test("a persistent Agenda Session keeps its own later Workspace selection", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using main = await tmpdir(),
      selected = await tmpdir()
    const scope = await main.scope()
    await ScopeContext.provide({
      scope,
      async fn() {
        const mainWorkspace = ScopeContext.current.workspace
        const origin = await Session.create({
          workspace: { type: "directory", path: selected.path, scopeID: scope.id },
        })
        const item = await AgendaStore.create({
          createdBy: "user",
          title: "Persistent",
          prompt: "test",
          sessionID: origin.id,
          triggers: [{ type: "every", interval: "1h" }],
          silent: true,
          wake: false,
        })
        const executions: Session.Info[] = []
        using _invoke = spyOn(SessionInvoke, "invoke").mockImplementation(
          fn(invokeSchema, async (input) => {
            executions.push(await Session.get(input.sessionID))
            throw new Error("Reached isolated model boundary")
          }),
        )
        const signal = { type: "manual" as const, source: item.id, timestamp: Date.now() }
        const first = await AgendaReactor.execute(signal, scope.id)
        expect(executions[0]!.workspaceID).toBe(origin.workspaceID)
        await Session.updateWorkspace(first.sessionID!, mainWorkspace)
        const second = await AgendaReactor.execute(signal, scope.id)
        expect(second.sessionID).toBe(first.sessionID)
        expect(executions[1]!.workspaceID).toBe(mainWorkspace!.id)
        expect((await AgendaStore.get(scope.id, item.id)).origin.workspaceID).toBe(origin.workspaceID)
      },
    })
  })
})

test("file watches require a selected Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await expect(
          AgendaStore.create({
            createdBy: "user",
            title: "No directory",
            prompt: "watch",
            triggers: [{ type: "watch", watch: { kind: "file", glob: "**/*" } }],
          }),
        ).rejects.toBeInstanceOf(Scope.WorkspaceRequiredError)
        const item = await AgendaStore.create({ createdBy: "user", title: "No directory", prompt: "timer" })
        await expect(
          AgendaStore.update("home", item.id, {
            triggers: [{ type: "watch", watch: { kind: "file", glob: "**/*" } }],
          }),
        ).rejects.toBeInstanceOf(Scope.WorkspaceRequiredError)
      },
    }),
  )
})

test("Agenda upgrades capture historical defaults once and preserve explicit selections", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const migration = migrations.find((entry) => entry.id === "20260923-agenda-workspace-reference")!
    await migration.up(() => {})
    await using main = await tmpdir(),
      other = await tmpdir()
    const scope = await main.scope()
    await ScopeContext.provide({
      scope,
      async fn() {
        const origin = await Session.create({ workspace: { type: "directory", path: other.path, scopeID: scope.id } })
        const legacy = await AgendaStore.create({
          createdBy: "user",
          title: "Historical",
          prompt: "test",
          sessionID: origin.id,
        })
        const explicit = await AgendaStore.create({
          createdBy: "user",
          title: "Current",
          prompt: "test",
          sessionID: origin.id,
        })
        const key = StoragePath.agendaItem(Identifier.asScopeID(scope.id), legacy.id)
        await Storage.update<AgendaTypes.Item & { future?: string }>(key, (item) => {
          delete item.origin.workspaceID
          item.future = "retained"
        })
        await migration.up(() => {})
        const upgraded = await Storage.read<AgendaTypes.Item & { future: string }>(key)
        expect(upgraded.origin.workspaceID).toBe(ScopeContext.current.workspace!.id)
        expect(upgraded.future).toBe("retained")
        expect((await AgendaStore.get(scope.id, explicit.id)).origin.workspaceID).toBe(origin.workspaceID)
        const count = (await WorkspaceCatalog.list(scope.id)).length
        await migration.up(() => {})
        expect(await Storage.read<typeof upgraded>(key)).toEqual(upgraded)
        expect((await WorkspaceCatalog.list(scope.id)).length).toBe(count)
      },
    })
  })
})

test("file watch startup and rebinding observe the captured directory without an open Session", async () => {
  await using runtime = await testRuntime({ SYNERGY_DISABLE_FILEWATCHER: "0" })
  await runtime.run(async () => {
    await using main = await tmpdir(),
      first = await tmpdir(),
      second = await tmpdir()
    const scope = await main.scope()
    await ScopeContext.provide({
      scope,
      async fn() {
        const origin = await Session.create({ workspace: { type: "directory", path: first.path, scopeID: scope.id } })
        const item = await AgendaStore.create({
          createdBy: "user",
          title: "Cold file watch",
          prompt: "changed",
          sessionID: origin.id,
          triggers: [{ type: "watch", watch: { kind: "file", glob: "*.txt", debounce: "10ms" } }],
        })
        const signals: AgendaTypes.FiredSignal[] = []
        const observe = async (directory: string, generation: number) => {
          const deadline = Date.now() + 5000
          let attempt = 0
          while (
            !signals.some((signal) => signal.payload?.workspaceGeneration === generation) &&
            Date.now() < deadline
          ) {
            await fs.writeFile(path.join(directory, `probe-${attempt++}.txt`), "native event")
            await Bun.sleep(100)
          }
          expect(signals.some((signal) => signal.payload?.workspaceGeneration === generation)).toBe(true)
          expect(signals.every((signal) => signal.payload?.workspaceID === origin.workspaceID)).toBe(true)
        }
        try {
          AgendaWatcher.start(
            async (signal) => {
              signals.push(signal)
            },
            [item],
          )
          await observe(first.path, 1)
          const current = await WorkspaceCatalog.get(origin.workspaceID!, scope.id)
          await WorkspaceBinding.rebind(current.id, {
            scopeID: scope.id,
            expectedRevision: current.revision,
            path: second.path,
          })
          await observe(second.path, 2)
          AgendaWatcher.stop()
          signals.length = 0
          await fs.writeFile(path.join(second.path, "after-stop.txt"), "stopped")
          await Bun.sleep(100)
          expect(signals).toEqual([])
          AgendaWatcher.start(
            async (signal) => {
              signals.push(signal)
            },
            [item],
          )
          await observe(second.path, 2)
        } finally {
          AgendaWatcher.stop()
        }
      },
    })
  })
}, 20000)

test.each(["directory", "none"])(
  "scheduled work retains its original %s Workspace after the origin changes",
  async (selection) => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using main = await tmpdir(),
        selected = await tmpdir()
      const scope = await main.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const origin = await Session.create({
            workspace: selection === "none" ? null : { type: "directory", path: selected.path, scopeID: scope.id },
          })
          const item = await AgendaStore.create({
            createdBy: "user",
            title: "Captured Workspace",
            prompt: "Inspect the selected files",
            sessionID: origin.id,
            triggers: [{ type: "at", at: Date.now() + 60000 }],
            silent: true,
            wake: false,
          })
          await Session.updateWorkspace(origin.id, ScopeContext.current.workspace)
          const executions: Session.Info[] = []
          using _invoke = spyOn(SessionInvoke, "invoke").mockImplementation(
            fn(invokeSchema, async (input) => {
              executions.push(await Session.get(input.sessionID))
              throw new Error("Reached isolated model boundary")
            }),
          )
          const result = await AgendaReactor.execute(
            { type: "manual", source: item.id, timestamp: Date.now() },
            scope.id,
          )
          expect(result.sessionID).toBeDefined()
          expect(executions).toHaveLength(1)
          expect(executions[0]!.workspaceID).toBe(origin.workspaceID)
          expect((await AgendaStore.get(scope.id, item.id)).origin).toMatchObject({ workspaceID: origin.workspaceID })
          expect(
            await AgendaDedup.findConflicts(
              scope.id,
              item.title,
              item.triggers,
              false,
              ScopeContext.current.workspace!.id!,
            ),
          ).toEqual([])
          expect(
            (
              await AgendaDedup.findConflicts(scope.id, item.title, item.triggers, false, origin.workspaceID ?? null)
            ).map((conflict) => conflict.item.id),
          ).toEqual([item.id])
        },
      })
    })
  },
)

test.each(["missing", "unbound"])(
  "unavailable %s Workspace records a failed run without invoking a model",
  async (state) => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using main = await tmpdir(),
        selected = await tmpdir()
      const scope = await main.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const origin = await Session.create({
            workspace: { type: "directory", path: selected.path, scopeID: scope.id },
          })
          const item = await AgendaStore.create({
            createdBy: "user",
            title: "Unavailable",
            prompt: "test",
            sessionID: origin.id,
            triggers: [{ type: "every", interval: "1h" }],
            silent: true,
            wake: false,
          })
          if (state === "missing") await fs.rm(selected.path, { recursive: true })
          else
            await Storage.update<WorkspaceCatalog.Info>(StoragePath.workspace(origin.workspaceID!), (record) => {
              record.binding.state = "unbound"
            })
          using invoke = spyOn(SessionInvoke, "invoke").mockImplementation(
            fn(invokeSchema, async () => {
              throw new Error("Model must not be reached")
            }),
          )
          await AgendaReactor.execute({ type: "manual", source: item.id, timestamp: Date.now() }, scope.id)
          expect(invoke).not.toHaveBeenCalled()
          expect((await AgendaStore.get(scope.id, item.id)).state).toMatchObject({ consecutiveErrors: 1, runCount: 1 })
          const runs = await AgendaStore.listRuns(scope.id, item.id)
          expect(runs).toHaveLength(1)
          expect(runs[0]!.status).toBe("error")
          expect(runs[0]!.error).toMatch(/Workspace|directory/i)
        },
      })
    })
  },
)

test("file watches exclude other Workspaces, other Scopes, missing provenance and retired generations", async () => {
  const { AgendaWatcher } = await import("../../src/agenda/watcher")
  const { GlobalBus } = await import("@ericsanchezok/synergy-harness/bus/global")
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using main = await tmpdir(),
      sibling = await tmpdir()
    const scope = await main.scope()
    await ScopeContext.provide({
      scope,
      async fn() {
        const origin = await Session.create({})
        const other = await Session.create({ workspace: { type: "directory", path: sibling.path, scopeID: scope.id } })
        const item = await AgendaStore.create({
          createdBy: "user",
          title: "Only this Workspace",
          prompt: "changed",
          sessionID: origin.id,
          global: true,
          triggers: [{ type: "watch", watch: { kind: "file", glob: "src/**/*.ts", debounce: "10ms" } }],
        })
        const calls: { source: string; scopeID: string }[] = []
        AgendaWatcher.start(
          async (signal, scopeID) => {
            calls.push({ source: signal.source, scopeID })
          },
          [item],
        )
        const emit = (scopeID: string | null, workspaceID?: string, workspaceGeneration?: number) =>
          GlobalBus().emit("event", {
            scopeID,
            payload: {
              type: "file.watcher.updated",
              properties: { file: "src/example.ts", event: "changed", workspaceID, workspaceGeneration },
            },
          })
        try {
          emit(scope.id, other.workspaceID!, other.workspace!.generation)
          emit("another-scope", origin.workspaceID!, origin.workspace!.generation)
          emit(scope.id)
          emit(scope.id, origin.workspaceID!, origin.workspace!.generation! + 1)
          await Bun.sleep(70)
          expect(calls).toEqual([])
          emit(scope.id, origin.workspaceID!, origin.workspace!.generation)
          const deadline = Date.now() + 2000
          while (!calls.length && Date.now() < deadline) await Bun.sleep(10)
          expect(calls).toEqual([{ source: item.id, scopeID: "home" }])
        } finally {
          AgendaWatcher.stop()
        }
      },
    })
  })
})
