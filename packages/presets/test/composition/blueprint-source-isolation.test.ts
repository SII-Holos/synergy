import { composeWithExperiments } from "../support/selected-components"
import { expect, test } from "bun:test"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { BlueprintLoopService } from "@ericsanchezok/synergy-blueprint/blueprint/service"
import { BlueprintLoopSources } from "@ericsanchezok/synergy-blueprint/blueprint/source"
import { BlueprintContinuationPolicy } from "@ericsanchezok/synergy-blueprint/blueprint/continuation"
import { WorkflowRecovery } from "@ericsanchezok/synergy-blueprint/session/recovery"
import { lattice } from "@ericsanchezok/synergy-lattice/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { pluginBlueprint } from "@ericsanchezok/synergy-plugin-blueprint/component"
import { server } from "@ericsanchezok/synergy-server/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"

async function open(home: string, selected: RuntimeComponent[]) {
  const components = RuntimeComponents.resolve([
    localRuntime({ workers: false, environment: false }),
    note(),
    blueprint(),
    server(),
    ...selected,
  ])
  const composition = composeWithExperiments(components)
  const adapters = await Promise.all(
    components.flatMap((item) => (item.adapters?.http ? [import(item.adapters.http.href)] : [])),
  )
  return testRuntime({
    home,
    env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ pluginMarketplace: { enabled: false } }) },
    composition: {
      register() {
        composition.register()
        for (const adapter of adapters) adapter.registerHttp()
      },
    },
  })
}

test("loop source registration stays within each Runtime across interleaving, close and failed startup", async () => {
  await using firstHome = await runtimeHome()
  await using secondHome = await runtimeHome()
  await using first = await open(firstHome.host.home, [lattice()])
  await using second = await open(secondHome.host.home, [])
  expect(await first.run(() => BlueprintLoopSources.ids())).toEqual(["lattice", "user"])
  expect(await second.run(() => BlueprintLoopSources.ids())).toEqual(["user"])
  await first.close()
  expect(await second.run(() => BlueprintLoopSources.available("lattice"))).toBe(false)
  await expect(
    open(firstHome.host.home, [
      lattice(),
      {
        id: "failing-source-fixture",
        version: "local",
        apiVersion: 1,
        after: ["lattice"],
        register() {
          expect(BlueprintLoopSources.available("lattice")).toBe(true)
          throw new Error("fixture startup failure")
        },
      },
    ]),
  ).rejects.toThrow("fixture startup failure")
  await using recovered = await open(firstHome.host.home, [])
  expect(await recovered.run(() => BlueprintLoopSources.ids())).toEqual(["user"])
  expect(await second.run(() => BlueprintLoopSources.ids())).toEqual(["user"])
})

for (const [source, components] of [
  ["lattice", [lattice()]],
  ["plugin", [plugins(), pluginBlueprint()]],
] satisfies Array<["lattice" | "plugin", RuntimeComponent[]]>) {
  test(`removing and reinstalling ${source} preserves its Blueprint runs without executing absent owners`, async () => {
    await using home = await runtimeHome()
    let snapshot: Awaited<ReturnType<typeof BlueprintLoopStore.get>>
    let sessionID = ""
    let noteSnapshot: unknown
    for (const phase of ["installed", "absent", "restored"] as const) {
      await using runtime = await open(
        home.host.home,
        phase === "absent" ? (source === "plugin" ? [plugins()] : []) : components,
      )
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            expect(() => BlueprintLoopSources.register("late-owner")).toThrow("before opening")
            const capabilities = await (await Server.App().request("/global/capabilities")).json()
            if (source === "plugin") {
              expect(capabilities.features).toContain("plugin-host")
              expect(capabilities.features.includes("plugin-blueprint")).toBe(phase !== "absent")
            }
            if (phase === "installed") {
              const document = await NoteStore.create({ title: "Preserved Blueprint", kind: "blueprint" })
              const session = await Session.create({ title: "Preserved execution" })
              sessionID = session.id
              if (source === "lattice")
                await Session.update(sessionID, (draft) => {
                  draft.workflow = { kind: "lattice", runID: "ltr_preserved", mode: "auto" }
                })
              const loop = await BlueprintLoopStore.create({
                noteID: document.id,
                title: document.title,
                sessionID,
                source,
              })
              await BlueprintLoopService.bindSessionToLoop(sessionID, loop.id, "execution")
              snapshot = await BlueprintLoopStore.updateStatus("home", loop.id, { status: "running" })
              noteSnapshot = await Storage.read(StoragePath.note(Identifier.asScopeID("home"), document.id))
              return
            }
            const session = await Session.get(sessionID)
            const gate = { session, sessionID, scopeID: "home", terminalMessageID: "msg_terminal" }
            expect(
              await SessionExecutionOwners.allowsMessage(session, {
                metadata: { source: "blueprint_loop_completed", loopID: snapshot.id },
              }),
            ).toBe(phase !== "absent")
            if (phase === "absent") {
              expect(await SessionExecutionOwners.allowsResume(session)).toBe(false)
              expect(BlueprintLoopSources.available(source)).toBe(false)
              expect(await BlueprintLoopStore.list("home")).toEqual([])
              expect(await (await Server.App().request("/blueprint/loop?scopeID=home")).json()).toEqual([])
              expect((await Server.App().request(`/blueprint/loop/${snapshot.id}?scopeID=home`)).status).toBe(404)
              await expect(
                BlueprintLoopStore.updateStatus("home", snapshot.id, { status: "cancelled" }),
              ).rejects.toBeInstanceOf(Storage.NotFoundError)
              await expect(
                BlueprintLoopStore.create({ noteID: snapshot.noteID, title: snapshot.title, sessionID, source }),
              ).rejects.toThrow()
              expect(await BlueprintContinuationPolicy.handle(gate)).toBeUndefined()
              expect(Session.publicInfo(session).blueprint).toBeUndefined()
              const visibleNote = await NoteStore.get("home", snapshot.noteID)
              expect(visibleNote.kind).toBe("blueprint")
              expect(visibleNote.blueprint?.activeLoopID).toBeUndefined()
              expect(visibleNote.blueprint?.lastRunAt).toBeUndefined()
              expect(visibleNote.blueprint?.runCount).toBeUndefined()
              const report: SessionRecovery.RuntimeReconcileReport = {
                scopes: ["home"],
                sessionsScanned: 0,
                loopsScanned: 0,
                changed: 0,
                entries: [],
              }
              await WorkflowRecovery.reconcileRuntimeScope({ scopeID: "home", apply: true, report })
              expect(report.changed).toBe(0)
              expect((await Session.get(sessionID)).blueprint).toEqual(session.blueprint)
            } else {
              expect(BlueprintLoopSources.available(source)).toBe(true)
              expect(await BlueprintLoopStore.get("home", snapshot.id)).toEqual(snapshot)
              expect(Session.publicInfo(session).blueprint).toMatchObject({ loopID: snapshot.id, source })
              expect((await NoteStore.get("home", snapshot.noteID)).blueprint).toMatchObject({
                activeLoopID: snapshot.id,
                activeLoopSource: source,
                lastRunSource: source,
                runCount: 1,
              })
              const proposal = await BlueprintContinuationPolicy.handle(gate)
              expect(proposal?.kind).toBe("inbox")
              if (proposal?.kind === "inbox")
                expect(proposal.message.metadata?.requiredFeatures).toEqual(
                  BlueprintLoopSources.requiredFeatures(source),
                )
            }
            expect(await BlueprintLoopStore.getStored("home", snapshot.id)).toEqual(snapshot)
            expect(
              await Storage.read<unknown>(StoragePath.note(Identifier.asScopeID("home"), snapshot.noteID)),
            ).toEqual(noteSnapshot)
          },
        }),
      )
    }
  }, 30_000)
}
