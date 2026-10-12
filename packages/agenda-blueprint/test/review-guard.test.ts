import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { AgendaStore } from "@ericsanchezok/synergy-agenda/agenda/store"
import { AgendaSessionWakeup } from "@ericsanchezok/synergy-agenda/agenda/session-wakeup"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { BlueprintLoopStopTool } from "@ericsanchezok/synergy-blueprint/blueprint/tools/blueprint-loop-stop"
import { registerWorker } from "../src/worker"
import { note } from "@ericsanchezok/synergy-note/component"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"

for (const selected of [false, true]) {
  test(`Agenda review bridge selected=${selected} controls wakeup guidance and review`, async () => {
    await using runtime = await testRuntime({
      composition: {
        register() {
          registerLocalRuntime()
          agenda().register()
          note().register()
          blueprint().register()
          if (selected) registerWorker()
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({})
          const loop = await BlueprintLoopStore.create({
            noteID: "note_blueprint",
            title: "Work",
            sessionID: session.id,
          })
          await BlueprintLoopStore.updateStatus(session.scope.id, loop.id, { status: "running" })
          await Session.update(session.id, (draft) => {
            draft.blueprint = { loopID: loop.id, loopRole: "execution" }
          })
          const item = await AgendaStore.create({
            title: "Wait",
            prompt: "Continue",
            triggers: [{ type: "delay", delay: "30m" }],
            wake: true,
            silent: false,
            autoDone: true,
            createdBy: "agent",
            sessionID: session.id,
          })
          const instruction = await AgendaSessionWakeup.loopInstruction({
            session: await Session.get(session.id),
            item,
          })
          expect(!!instruction).toBe(selected)
          if (selected) expect(instruction!.text).toContain("blueprint_loop_stop")
          await Session.update(session.id, (draft) => {
            draft.blueprint = { loopID: loop.id, loopRole: "execution" }
          })
          const tool = await BlueprintLoopStopTool.init()
          const context = {
            sessionID: session.id,
            messageID: "message_stop",
            agent: "build",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          }
          if (selected) {
            await expect(tool.execute({ summary: "Verified" }, context)).rejects.toThrow(
              "while Agenda items can still wake this session",
            )
            await AgendaStore.update(session.scope.id, item.id, { status: "cancelled" })
          }
          const result = await tool.execute({ summary: "Verified" }, context)
          expect(result.metadata.loopStopRequested).toBe(true)
          expect(
            await AgendaSessionWakeup.loopInstruction({ session: await Session.get(session.id), item }),
          ).toBeUndefined()
        },
      }),
    )
  })
}
