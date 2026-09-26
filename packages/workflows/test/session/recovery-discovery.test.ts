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

afterRuntimeTests(() => runtime.close())
