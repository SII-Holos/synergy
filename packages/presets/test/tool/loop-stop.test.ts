import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { describe, expect, test } from "bun:test"
import { AgendaStore } from "@ericsanchezok/synergy-agenda/agenda/store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { LoopStopTool } from "@ericsanchezok/synergy-light-loop/light-loop/tools/loop-stop"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
// Wire the L4-injected agenda wakeup guard (same pattern as blueprint-loop-tools.test.ts).
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: PrimaryAgentIdentity.names.general,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}
describe("Light Loop Agenda completion guard", () => {
  test("rejects completion while an Agenda item can still wake the Light Loop session", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ workflow: { kind: "lightloop", instructions: "Test task" } })
          const agenda = await AgendaStore.create({
            title: "Experiment progress",
            prompt: "Check the experiment",
            triggers: [{ type: "every", interval: "30m" }],
            wake: true,
            silent: false,
            autoDone: true,
            createdBy: "agent",
            sessionID: session.id,
          })

          const tool = await LoopStopTool.init()
          await expect(tool.execute({ summary: "done" }, ctx(session.id))).rejects.toThrow(
            `agenda_cancel(id="${agenda.id}")`,
          )
          expect((await Session.get(session.id)).workflow?.kind).toBe("lightloop")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
