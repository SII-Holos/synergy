import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { CortexEvent } from "../../src/cortex/event"
import { CortexTypes } from "../../src/cortex/types"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { tmpdir } from "../fixture/fixture"

describe("Cortex restart recovery", () => {
  test("publishes an interrupted workflow contractor as a terminal task", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        const taskID = Identifier.short("cortex")
        const child = await Session.create({
          parentID: parent.id,
          cortex: {
            taskID,
            parentSessionID: parent.id,
            parentMessageID: Identifier.ascending("message"),
            description: "Interrupted workflow contractor",
            agent: "synergy",
            startedAt: Date.now(),
            status: "running",
            visibility: "hidden",
            owner: {
              kind: "workflow_run",
              runID: "wfr_restart_recovery",
              entityID: "wfe_restart_recovery",
              correlationID: "contractor-restart",
            },
          },
        })
        let terminal: CortexTypes.Task | undefined
        const unsubscribe = Bus.subscribe(CortexEvent.TaskCompleted, (event) => {
          if (event.properties.task.id === taskID) terminal = event.properties.task
        })

        try {
          await SessionInvoke.resumePending()
        } finally {
          unsubscribe()
        }

        expect((await Session.get(child.id)).cortex?.status).toBe("interrupted")
        expect(terminal).toMatchObject({
          id: taskID,
          sessionID: child.id,
          parentSessionID: parent.id,
          status: "interrupted",
          visibility: "hidden",
          owner: {
            kind: "workflow_run",
            runID: "wfr_restart_recovery",
            entityID: "wfe_restart_recovery",
          },
        })
      },
    })
  })
})
