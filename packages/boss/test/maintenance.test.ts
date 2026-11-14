import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionTransferOwners as Owners } from "@ericsanchezok/synergy-harness/session/transfer"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { registerMaintenance } from "../src/maintenance"

test("Boss history maintenance preserves tree identity without enabling private context or execution", async () => {
  await using runtime = await testRuntime({ register: registerMaintenance })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        await Session.update(root.id, (draft) => {
          draft.workflow = { kind: "boss", role: "boss", instructions: "Retain standing instructions" }
        })
        const child = await Session.create({ parentID: root.id, workspace: null })
        await Session.update(child.id, (draft) => {
          draft.workflow = { kind: "boss", role: "worker", rootID: root.id, workerRole: "Recorded role" }
        })
        const session = await Session.get(root.id)
        expect(session.workflow).toMatchObject({
          kind: "boss",
          role: "boss",
          instructions: "Retain standing instructions",
        })
        expect(
          await Owners.selected({
            session,
            rootSessionID: root.id,
            handoffID: "maintenance",
            signal: new AbortController().signal,
          }),
        ).toContain("boss")
        expect(RuntimeComponents.selected().map((component) => component.id)).not.toContain("library")
        expect(RuntimeComponents.selected().map((component) => component.id)).not.toContain("agenda")
        expect(WorkflowKindRegistry.get("boss")).toBeUndefined()
        expect(WorkflowPromptRegistry.get("boss")).toBeUndefined()
        expect((await Agent.list()).some((agent) => agent.name === "boss-synergy")).toBe(false)
        await expect(SessionExecutionOwners.assertResume(session)).rejects.toThrow("not available")
        expect(await SessionInbox.list(root.id)).toEqual([])
      },
    }),
  )
})
