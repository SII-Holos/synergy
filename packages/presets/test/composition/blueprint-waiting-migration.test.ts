import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { upgradeImportedRecord } from "@ericsanchezok/synergy-harness/migration"

const historicalPhase = "20260920-session-blueprint-waiting-phase"
const historicalNav = "20260920-session-nav-blueprint-waiting-phase"
const ownerPhase = "20261012-blueprint-session-waiting-phase"

for (const receipt of ["pending", "completed"] as const) {
  test(`retained Blueprint waiting state belongs to its installed owner with ${receipt} historical receipts`, async () => {
    await using home = await runtimeHome()
    let sessionID = ""
    const legacy = { loopID: "bll_retained", loopRole: "execution", phase: "waiting", future: { keep: true } }
    let converted: Record<string, unknown> | undefined
    for (const selection of ["seed", "core", "light-loop", "blueprint", "core", "blueprint"]) {
      await using runtime = await testRuntime({
        home: home.host.home,
        composition: RuntimeComponents.compose([
          localRuntime({ workers: false, environment: false }),
          ...(selection === "blueprint" ? [note(), blueprint()] : []),
          ...(selection === "light-loop" ? [lightLoop()] : []),
        ]),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            if (selection === "seed") {
              sessionID = (await Session.create({ title: "Retained Blueprint hold" })).id
              const key = ["sessions", "home", sessionID, "info"]
              await Storage.write(key, {
                ...(await Storage.read<Record<string, unknown>>(key)),
                blueprint: legacy,
                futureOwner: { retained: true },
              })
              await Storage.write(["blueprint_loops", "home", legacy.loopID], {
                id: legacy.loopID,
                scopeID: "home",
                sessionID,
                noteID: "nte_retained",
                title: "Retained user loop",
                source: "user",
                status: "running",
                auditAgent: "supervisor",
                time: { created: 1, updated: 1 },
              })
              const logKey = StoragePath.metaMigrationLogDomain("session")
              const ledger = await Storage.read<Record<string, number>>(logKey)
              for (const id of [historicalPhase, historicalNav]) {
                if (receipt === "completed") ledger[id] = 42
                else delete ledger[id]
              }
              await Storage.write(logKey, ledger)
              return
            }
            const key = ["sessions", "home", sessionID, "info"]
            const current = await Session.get(sessionID)
            const raw = await Storage.read<Record<string, unknown>>(key)
            const imported = upgradeImportedRecord(key, { ...raw, blueprint: legacy, paused: undefined })
            if (selection === "blueprint") {
              expect(raw.blueprint).toEqual({ ...legacy, phase: "running", source: "user" })
              expect(raw.paused).toMatchObject({ reason: "workflow" })
              expect(imported).toMatchObject({
                blueprint: { ...legacy, phase: "running" },
                paused: { reason: "workflow" },
              })
              expect(
                await Storage.read(["sessions", "home", sessionID, "migrations", "blueprint-session", ownerPhase]),
              ).toHaveProperty("completed")
              const entry = (await SessionNav.readNavIndex("home")).entries.find((item) => item.id === sessionID)
              expect(entry?.blueprint).toEqual({ loopID: legacy.loopID, loopRole: "execution", phase: "running" })
              if (converted) expect(raw).toEqual(converted)
              converted = raw
            } else {
              expect(raw.blueprint).toEqual(converted ? { ...legacy, phase: "running", source: "user" } : legacy)
              expect(raw.paused).toEqual(converted?.paused)
              expect(imported).toMatchObject({ blueprint: legacy })
              expect(Session.publicInfo(current)).not.toHaveProperty("blueprint")
              if (!converted)
                expect(
                  (
                    await Storage.readMany([
                      ["sessions", "home", sessionID, "migrations", "blueprint-session", ownerPhase],
                    ])
                  )[0],
                ).toBeUndefined()
            }
            expect(raw.futureOwner).toEqual({ retained: true })
            const ledger = await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("session"))
            expect(ledger[historicalPhase]).toBeGreaterThan(0)
            expect(ledger[historicalNav]).toBeGreaterThan(0)
            if (receipt === "completed") expect(ledger[historicalPhase]).toBe(42)
          },
        }),
      )
    }
  }, 30_000)
}
