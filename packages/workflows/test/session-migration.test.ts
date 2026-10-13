import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

function ownerMigration(owner: "blueprint" | "light-loop" | "lattice") {
  const migration = MigrationRegistry.list()
    .get(`${owner}-session`)
    ?.find((entry) => entry.id === `20261012-${owner}-session-owner`)
  if (!migration) throw new Error(`Missing registered ${owner} session migration`)
  return migration
}

describe("workflow session migrations", () => {
  test("migrates legacy workflow session fields and upgrades message metadata on canonical reads", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const tmpScope = await tmp.scope()

      await ScopeContext.provide({
        scope: tmpScope,
        fn: async () => {
          const latticeSession = await Session.create({ title: "Legacy Lattice" })
          const lightloopSession = await Session.create({ title: "Legacy Light Loop" })
          const planSession = await Session.create({ title: "Legacy Plan" })
          const conflictSession = await Session.create({ title: "Legacy Conflict" })
          const scope = Identifier.asScopeID(tmpScope.id)

          await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(latticeSession.id)), {
            ...latticeSession,
            planMode: true,
            lightLoop: { active: true, taskDescription: "ignored" },
            lattice: { runID: "ltr_legacy", mode: "auto", firstBlueprintStarted: true },
          })
          await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(lightloopSession.id)), {
            ...lightloopSession,
            lightLoop: { active: true, taskDescription: "Keep going" },
          })
          await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(planSession.id)), {
            ...planSession,
            planMode: true,
          })

          const loopID = Identifier.ascending("blueprint_loop")
          await Storage.write(StoragePath.blueprintLoop(scope, loopID), {
            id: loopID,
            noteID: "note_conflict",
            title: "Conflict Loop",
            sessionID: conflictSession.id,
            scopeID: scope,
            status: "running",
            source: "user",
            time: { created: Date.now(), updated: Date.now() },
          })
          await Storage.write(StoragePath.sessionInfo(scope, Identifier.asSessionID(conflictSession.id)), {
            ...conflictSession,
            blueprint: { loopID },
            planMode: true,
            lightLoop: { active: true, taskDescription: "conflict" },
          })

          const planMessageID = Identifier.ascending("message")
          await Storage.write(StoragePath.messageInfo(scope, Identifier.asSessionID(planSession.id), planMessageID), {
            id: planMessageID,
            sessionID: planSession.id,
            role: "user",
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
            time: { created: 1 },
            origin: { type: "user" },
            isRoot: true,
            metadata: {
              planModeRequest: true,
              planModeAgent: "synergy",
              planModeWrapperVersion: 1,
              keep: "value",
            },
          })

          const lightloopMessageID = Identifier.ascending("message")
          await Storage.write(
            StoragePath.messageInfo(scope, Identifier.asSessionID(lightloopSession.id), lightloopMessageID),
            {
              id: lightloopMessageID,
              sessionID: lightloopSession.id,
              role: "user",
              agent: "general",
              model: { providerID: "fixture", modelID: "fixture" },
              time: { created: 1 },
              origin: { type: "user" },
              isRoot: true,
              metadata: {
                workflowMode: "light_loop",
                workflowModeAgent: "synergy-max",
                workflowModeVersion: 1,
              },
            },
          )

          for (const owner of ["blueprint", "light-loop", "lattice"] as const) {
            await ownerMigration(owner).up(() => {})
            await ownerMigration(owner).up(() => {})
          }

          const migratedLattice = await Storage.read<any>(
            StoragePath.sessionInfo(scope, Identifier.asSessionID(latticeSession.id)),
          )
          const migratedLightloop = await Storage.read<any>(
            StoragePath.sessionInfo(scope, Identifier.asSessionID(lightloopSession.id)),
          )
          const migratedPlan = await Storage.read<any>(
            StoragePath.sessionInfo(scope, Identifier.asSessionID(planSession.id)),
          )
          const migratedConflict = await Storage.read<any>(
            StoragePath.sessionInfo(scope, Identifier.asSessionID(conflictSession.id)),
          )

          expect(migratedLattice.workflow).toEqual({
            kind: "lattice",
            runID: "ltr_legacy",
            mode: "auto",
          })
          expect(migratedLightloop.workflow).toEqual({ kind: "lightloop", instructions: "Keep going" })
          expect(migratedPlan.workflow).toEqual({ kind: "plan" })
          expect(migratedConflict.workflow).toBeUndefined()

          expect(migratedLattice.lattice).toBeUndefined()
          expect(migratedLattice.planMode).toBe(true)
          expect(migratedLattice.lightLoop).toEqual({ active: true, taskDescription: "ignored" })
          expect(migratedLightloop.lightLoop).toBeUndefined()
          expect(migratedPlan.planMode).toBeUndefined()
          expect(migratedConflict.planMode).toBe(true)
          expect(migratedConflict.lightLoop).toEqual({ active: true, taskDescription: "conflict" })
          expect(migratedConflict.blueprint).toEqual({ loopID })

          const planKey = StoragePath.messageInfo(scope, Identifier.asSessionID(planSession.id), planMessageID)
          const lightloopKey = StoragePath.messageInfo(
            scope,
            Identifier.asSessionID(lightloopSession.id),
            lightloopMessageID,
          )
          expect(await Storage.read<unknown>(planKey)).toHaveProperty("metadata.planModeRequest", true)
          expect(await Storage.read<unknown>(lightloopKey)).toHaveProperty("metadata.workflowMode", "light_loop")
          const migratedPlanMessage = await MessageV2.get({ sessionID: planSession.id, messageID: planMessageID })
          expect(migratedPlanMessage.info.metadata).toEqual({
            workflow: "plan",
            workflowAgent: "synergy",
            workflowVersion: 1,
            keep: "value",
          })

          const migratedLightloopMessage = await MessageV2.get({
            sessionID: lightloopSession.id,
            messageID: lightloopMessageID,
          })
          expect(migratedLightloopMessage.info.metadata).toEqual({
            workflow: "lightloop",
            workflowAgent: "synergy-max",
            workflowVersion: 1,
          })
        },
      })
    }))
  test("migrates legacy Light Loop task descriptions to canonical instructions", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const tmpScope = await tmp.scope()

      await ScopeContext.provide({
        scope: tmpScope,
        fn: async () => {
          const legacySession = await Session.create({ title: "Legacy Light Loop" })
          const migratedSession = await Session.create({ title: "Migrated Light Loop" })
          const currentSession = await Session.create({ title: "Current Light Loop" })
          const scope = Identifier.asScopeID(tmpScope.id)
          const legacyKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(legacySession.id))
          const migratedKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(migratedSession.id))
          const currentKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(currentSession.id))

          await Storage.write(legacyKey, {
            ...legacySession,
            lightLoop: { active: true, taskDescription: "Resume the legacy task" },
          })
          await Storage.write(migratedKey, {
            ...migratedSession,
            workflow: { kind: "lightloop", taskDescription: "Resume the migrated task" },
          })
          await Storage.write(currentKey, {
            ...currentSession,
            workflow: { kind: "lightloop", instructions: "Keep current instructions" },
          })

          const migration = ownerMigration("light-loop")
          await migration.up(() => {})

          expect((await Storage.read<any>(legacyKey)).workflow).toEqual({
            kind: "lightloop",
            instructions: "Resume the legacy task",
          })
          expect((await Storage.read<any>(migratedKey)).workflow).toEqual({
            kind: "lightloop",
            instructions: "Resume the migrated task",
          })
          const legacy = await Storage.read<any>(legacyKey)
          const migrated = await Storage.read<any>(migratedKey)
          const current = await Storage.read<any>(currentKey)
          expect(current.workflow).toEqual({ kind: "lightloop", instructions: "Keep current instructions" })

          await migration!.up(() => {})
          expect(await Storage.read<any>(legacyKey)).toEqual(legacy)
          expect(await Storage.read<any>(migratedKey)).toEqual(migrated)
          expect(await Storage.read<any>(currentKey)).toEqual(current)
        },
      })
    }))
  test("moves terminal plugin Light Loops out of the interactive workflow slot", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const tmpScope = await tmp.scope()

      await ScopeContext.provide({
        scope: tmpScope,
        fn: async () => {
          const completed = await Session.create({ title: "Completed ordinary Light Loop" })
          const exhausted = await Session.create({ title: "Exhausted ordinary Light Loop" })
          const active = await Session.create({ title: "Active ordinary Light Loop" })
          const plugin = await Session.create({ title: "Completed plugin Light Loop" })
          const scope = Identifier.asScopeID(tmpScope.id)
          const completedKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(completed.id))
          const exhaustedKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(exhausted.id))
          const activeKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(active.id))
          const pluginKey = StoragePath.sessionInfo(scope, Identifier.asSessionID(plugin.id))
          const terminalKey = StoragePath.sessionLightLoopTerminal(scope, Identifier.asSessionID(plugin.id))

          await Storage.write(completedKey, {
            ...completed,
            workflow: { kind: "lightloop", instructions: "Done", status: "completed" },
          })
          await Storage.write(exhaustedKey, {
            ...exhausted,
            workflow: { kind: "lightloop", instructions: "Stopped", status: "iteration_exhausted" },
          })
          await Storage.write(activeKey, {
            ...active,
            workflow: { kind: "lightloop", instructions: "Keep going", status: "running" },
          })
          await Storage.write(pluginKey, {
            ...plugin,
            workflow: {
              kind: "lightloop",
              instructions: "Notify the plugin",
              status: "completed",
              pluginOwner: {
                pluginId: "test-plugin",
                pluginGeneration: "generation-one",
                scopeId: tmpScope.id,
                correlationId: "correlation-one",
              },
              terminalHookError: "handler unavailable",
            },
          })

          const migration = ownerMigration("light-loop")
          await migration.up(() => {})

          expect((await Storage.read<any>(completedKey)).workflow).toBeUndefined()
          expect((await Storage.read<any>(exhaustedKey)).workflow).toBeUndefined()
          expect((await Storage.read<any>(activeKey)).workflow).toEqual({
            kind: "lightloop",
            instructions: "Keep going",
            status: "running",
          })
          expect((await Storage.read<any>(pluginKey)).workflow).toBeUndefined()
          expect(await Storage.read<any>(terminalKey)).toEqual({
            sessionID: plugin.id,
            status: "completed",
            instructions: "Notify the plugin",
            pluginOwner: {
              pluginId: "test-plugin",
              pluginGeneration: "generation-one",
              scopeId: tmpScope.id,
              correlationId: "correlation-one",
            },
            hookError: "handler unavailable",
            createdAt: plugin.time.updated,
          })

          const first = await Promise.all(
            [completedKey, exhaustedKey, activeKey, pluginKey, terminalKey].map((key) => Storage.read<any>(key)),
          )
          await migration!.up(() => {})
          const second = await Promise.all(
            [completedKey, exhaustedKey, activeKey, pluginKey, terminalKey].map((key) => Storage.read<any>(key)),
          )
          expect(second).toEqual(first)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
