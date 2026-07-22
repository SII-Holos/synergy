import { describe, expect, test } from "bun:test"
import { AgendaSessionWakeup } from "../../src/agenda/session-wakeup"
import { AgendaStore } from "../../src/agenda/store"
import { BlueprintLoopStore } from "../../src/blueprint"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

async function createWakeup(sessionID: string) {
  return AgendaStore.create({
    title: "Check loop progress",
    prompt: "Check the loop",
    triggers: [{ type: "every", interval: "30m" }],
    wake: true,
    silent: false,
    autoDone: true,
    createdBy: "agent",
    sessionID,
  })
}

describe("AgendaSessionWakeup.loopInstruction", () => {
  test("does not wake a Light Loop after its stop intent is recorded", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Complete the task",
            stopRequest: {
              summary: "Done",
              requestedAt: Date.now(),
              requesterSessionID: session.id,
              requesterMessageID: "msg_stop",
            },
          }
        })
        const item = await createWakeup(session.id)

        expect(
          await AgendaSessionWakeup.loopInstruction({
            session: await Session.get(session.id),
            item,
          }),
        ).toBeUndefined()
      },
    })
  })

  test("does not wake a BlueprintLoop after its stop intent is recorded", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const loop = await BlueprintLoopStore.create({
          noteID: "note_blueprint",
          title: "Test Blueprint",
          sessionID: session.id,
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
        await BlueprintLoopStore.recordStopRequest(ScopeContext.current.scope.id, loop.id, {
          summary: "Done",
          requestedAt: Date.now(),
          requesterSessionID: session.id,
          requesterMessageID: "msg_stop",
        })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        const item = await createWakeup(session.id)

        expect(
          await AgendaSessionWakeup.loopInstruction({
            session: await Session.get(session.id),
            item,
          }),
        ).toBeUndefined()
      },
    })
  })
})
