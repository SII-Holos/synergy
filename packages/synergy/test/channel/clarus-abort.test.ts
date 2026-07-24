import { describe, expect, test } from "bun:test"
import { AgendaStore } from "../../src/agenda/store"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { registerProviders } from "../../src/channel/provider"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { SessionAbort } from "../../src/session/abort"
import { tmpdir } from "../fixture/fixture"
import { taskAssignedEvent } from "./clarus-fixture"

function createHost(accountId: string) {
  return ChannelHost.create({ channelType: "clarus", accountId, activateTasks: false })
}

describe("Clarus assignment Session Abort lifecycle", () => {
  test("explicit abort cancels the assignment reminder without deleting result state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        registerProviders()
        const accountId = `abort-account-${crypto.randomUUID()}`
        const projectID = `abort-project-${crypto.randomUUID()}`
        const taskID = `abort-task-${crypto.randomUUID()}`
        const host = createHost(accountId)
        const project = await host.projects.ensure({
          externalProjectId: projectID,
          name: "Abort project",
          isActive: true,
        })
        const projectScope = await Scope.fromID(project.scopeID)
        if (!projectScope) throw new Error("Clarus Project Scope not found")
        const event = taskAssignedEvent({
          agentID: accountId,
          projectID,
          taskID,
          runID: "abort-run-1",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        const dispatched = await ClarusAssignmentRuntime.dispatch({ host, accountId, event })

        expect(
          (await AgendaStore.list(project.scopeID)).filter((item) => item.tags?.includes("deadline")),
        ).toHaveLength(1)

        await ScopeContext.provide({
          scope: projectScope,
          fn: () => SessionAbort.abort(dispatched.assignment.sessionID),
        })

        expect(
          (await ClarusAssignmentStore.findBySessionID(dispatched.assignment.sessionID))?.assignment,
        ).toMatchObject({
          status: "cancelled",
          resultState: "none",
        })
        const reminders = (await AgendaStore.list(project.scopeID)).filter((item) => item.tags?.includes("deadline"))
        expect(reminders).toHaveLength(1)
        expect(reminders[0]!.status).toBe("cancelled")
      },
    })
  })

  test("exact assignment replay does not reactivate an aborted reminder, but a new run does", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        registerProviders()
        const accountId = `replay-abort-account-${crypto.randomUUID()}`
        const projectID = `replay-abort-project-${crypto.randomUUID()}`
        const taskID = `replay-abort-task-${crypto.randomUUID()}`
        const host = createHost(accountId)
        const project = await host.projects.ensure({
          externalProjectId: projectID,
          name: "Replay abort",
          isActive: true,
        })
        const projectScope = await Scope.fromID(project.scopeID)
        if (!projectScope) throw new Error("Clarus Project Scope not found")
        const event = taskAssignedEvent({
          agentID: accountId,
          projectID,
          taskID,
          runID: "abort-run-1",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        const dispatched = await ClarusAssignmentRuntime.dispatch({ host, accountId, event })

        await ScopeContext.provide({
          scope: projectScope,
          fn: () => SessionAbort.abort(dispatched.assignment.sessionID),
        })
        await ClarusAssignmentRuntime.dispatch({ host, accountId, event })

        let reminders = (await AgendaStore.list(project.scopeID)).filter((item) => item.tags?.includes("deadline"))
        expect(reminders).toHaveLength(1)
        expect(reminders[0]!.status).toBe("cancelled")
        expect((await ClarusAssignmentStore.findBySessionID(dispatched.assignment.sessionID))?.assignment.status).toBe(
          "cancelled",
        )

        await ClarusAssignmentRuntime.dispatch({
          host,
          accountId,
          event: { ...event, runID: "abort-run-2" },
        })

        reminders = (await AgendaStore.list(project.scopeID)).filter((item) => item.tags?.includes("deadline"))
        expect(reminders).toHaveLength(1)
        expect(reminders[0]!.status).toBe("active")
        expect((await ClarusAssignmentStore.findBySessionID(dispatched.assignment.sessionID))?.assignment.status).toBe(
          "running",
        )
      },
    })
  })
})
