import { expect, spyOn, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkflowRecovery } from "../../src/session/recovery"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("workflow status discovery does not traverse historical session trees", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessions = await Promise.all(Array.from({ length: 12 }, () => Session.create({ title: "History" })))
        try {
          using scan = spyOn(Storage, "scan")
          expect(await WorkflowRecovery.recoverableStatuses(sessions[0].scope.id)).toEqual({})
          expect(scan.mock.calls.filter(([key]) => key[0] === "sessions")).toHaveLength(0)
        } finally {
          for (const session of sessions) await Session.remove(session.id)
        }
      },
    })
  }))

test("persisted pauses are projected from the indexed batch without individual session hydration", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessions = await Promise.all(
          Array.from({ length: 12 }, () => Session.create({ title: "Paused history" })),
        )
        for (const session of sessions)
          await Session.update(session.id, (draft) => {
            draft.paused = { reason: "interrupted", since: 123 }
          })
        try {
          using reads = spyOn(Storage, "readMany")
          const statuses = await WorkflowRecovery.recoverableStatuses(sessions[0].scope.id)
          expect(Object.keys(statuses).sort()).toEqual(sessions.map((session) => session.id).sort())
          expect(Object.values(statuses).every((status) => status.type === "paused" && status.since === 123)).toBe(true)
          expect(
            reads.mock.calls.flatMap(([keys]) => keys).filter((key) => key[0] === "sessions" && key[3] === "info"),
          ).toHaveLength(0)
        } finally {
          for (const session of sessions) await Session.remove(session.id)
        }
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
