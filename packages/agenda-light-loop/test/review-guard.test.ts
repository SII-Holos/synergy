import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { AgendaStore } from "@ericsanchezok/synergy-agenda/agenda/store"
import { AgendaSessionWakeup } from "@ericsanchezok/synergy-agenda/agenda/session-wakeup"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { LoopStopTool } from "@ericsanchezok/synergy-light-loop/light-loop/tools/loop-stop"
import { registerWorker } from "../src/worker"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"

for (const selected of [false, true]) {
  test(`Agenda review bridge selected=${selected} controls wakeup guidance and review`, async () => {
    await using runtime = await testRuntime({
      composition: {
        register() {
          registerLocalRuntime()
          agenda().register()
          lightLoop().register()
          if (selected) registerWorker()
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const agent = await Agent.get(PrimaryAgentIdentity.names.general)
          const guidance = AgentPromptContributions.render(agent, new Set(["loop_stop", "agenda_cancel"]))
          expect(guidance.join("\n").includes("all active Agenda wakeups")).toBe(selected)
          expect(guidance.join("\n")).not.toMatch(/loop_stop|agenda_cancel/)
          expect(AgentPromptContributions.render(agent, new Set(["loop_stop"]))).toEqual([])
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.workflow = { kind: "lightloop", instructions: "Complete the work" }
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
          if (selected) {
            expect(instruction!.text).toContain("loop_stop")
            expect(instruction!.text).toContain(item.id)
            expect(instruction!.text).toContain("complete task is finished and verified")
            expect(instruction!.text).not.toMatch(/agenda_cancel\(|Call loop_stop with/)
          }
          const tool = await LoopStopTool.init()
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
          expect(result.metadata.loopCompleted).toBe(true)
          expect(
            await AgendaSessionWakeup.loopInstruction({ session: await Session.get(session.id), item }),
          ).toBeUndefined()
        },
      }),
    )
  })
}
