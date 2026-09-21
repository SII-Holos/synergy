import { describe, expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionNav, type SessionNavEntry } from "@ericsanchezok/synergy-harness/session/nav"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { WorkflowSessionService } from "../../src/session/workflow"

async function withScope(fn: (scopeID: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  await ScopeContext.provide({ scope, fn: () => fn(scope.id) })
}

async function bindLoopSession(sessionID: string, loopID: string, loopRole: "execution" | "audit") {
  await Session.update(sessionID, (draft) => {
    draft.blueprint = { ...draft.blueprint, loopID, loopRole }
  })
}

describe("BlueprintLoop session phase projection", () => {
  test("carries the loop status onto the bound execution session", async () => {
    await withScope(async (scopeID) => {
      const execution = await Session.create({ title: "Execution" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_phase",
        title: "Phase Blueprint",
        sessionID: execution.id,
      })
      await bindLoopSession(execution.id, loop.id, "execution")

      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
      expect((await Session.get(execution.id)).blueprint?.phase).toBe("running")

      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "auditing" })
      expect((await Session.get(execution.id)).blueprint?.phase).toBe("auditing")
      expect((await Session.get(execution.id)).blueprint?.loopRole).toBe("execution")

      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
      expect((await Session.get(execution.id)).blueprint?.phase).toBe("running")

      await Session.remove(execution.id)
    })
  })

  test("carries the auditing phase onto both bound sessions", async () => {
    await withScope(async (scopeID) => {
      const execution = await Session.create({ title: "Execution" })
      const audit = await Session.create({ title: "Audit" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_audit_phase",
        title: "Audit Blueprint",
        sessionID: execution.id,
      })
      await bindLoopSession(execution.id, loop.id, "execution")
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })

      await bindLoopSession(audit.id, loop.id, "audit")
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
        status: "auditing",
        auditSessionID: audit.id,
        auditTaskID: "ctx_audit_phase",
      })

      expect((await Session.get(execution.id)).blueprint?.phase).toBe("auditing")
      expect((await Session.get(audit.id)).blueprint).toEqual({ loopID: loop.id, loopRole: "audit", phase: "auditing" })

      await Session.remove(execution.id)
      await Session.remove(audit.id)
    })
  })

  test("clears the phase and the binding when the loop reaches a terminal status", async () => {
    await withScope(async (scopeID) => {
      const execution = await Session.create({ title: "Execution" })
      const audit = await Session.create({ title: "Audit" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_terminal_phase",
        title: "Terminal Blueprint",
        sessionID: execution.id,
      })
      await bindLoopSession(execution.id, loop.id, "execution")
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
      await bindLoopSession(audit.id, loop.id, "audit")
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
        status: "auditing",
        auditSessionID: audit.id,
        auditTaskID: "ctx_terminal_phase",
      })

      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "completed" })

      const executionBlueprint = (await Session.get(execution.id)).blueprint
      const auditBlueprint = (await Session.get(audit.id)).blueprint
      expect(executionBlueprint?.loopID).toBeUndefined()
      expect(executionBlueprint?.loopRole).toBeUndefined()
      expect(executionBlueprint?.phase).toBeUndefined()
      expect(auditBlueprint?.loopID).toBeUndefined()
      expect(auditBlueprint?.phase).toBeUndefined()

      await Session.remove(execution.id)
      await Session.remove(audit.id)
    })
  })

  test("never re-phases a session that is bound to a different loop", async () => {
    await withScope(async (scopeID) => {
      const execution = await Session.create({ title: "Execution" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_rebind",
        title: "Rebind Blueprint",
        sessionID: execution.id,
      })
      await Session.update(execution.id, (draft) => {
        draft.blueprint = { loopID: "bll_other", loopRole: "execution" }
      })

      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })

      expect((await Session.get(execution.id)).blueprint).toEqual({ loopID: "bll_other", loopRole: "execution" })

      await Session.remove(execution.id)
    })
  })
})

describe("SessionNav Blueprint identity", () => {
  test("both nav producers carry the bound loop role and phase", async () => {
    await withScope(async (scopeID) => {
      const execution = await Session.create({ title: "Execution" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_nav_identity",
        title: "Nav Blueprint",
        sessionID: execution.id,
      })
      await bindLoopSession(execution.id, loop.id, "execution")
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "auditing" })

      const live = (await SessionNav.readNavIndex(scopeID)).entries.find((entry) => entry.id === execution.id)
      const rebuilt = (await SessionNav.buildNavIndex(scopeID)).entries.find((entry) => entry.id === execution.id)
      const expected: NonNullable<SessionNavEntry["blueprint"]> = {
        loopID: loop.id,
        loopRole: "execution",
        phase: "auditing",
      }
      expect(live?.blueprint).toEqual(expected)
      expect(rebuilt?.blueprint).toEqual(live?.blueprint)

      await Session.remove(execution.id)
    })
  })
})

describe("SessionNav workflow activity", () => {
  test("marks an active Light Loop as active and a terminal one as inactive", async () => {
    await withScope(async () => {
      const session = await Session.create({ title: "Light Loop" })
      await WorkflowSessionService.startLightloop(session.id, "Ship the feature")

      expect(SessionNav.deriveSessionIdentity(await Session.get(session.id)).workflow).toEqual({
        kind: "lightloop",
        active: true,
      })

      await Session.update(session.id, (draft) => {
        if (draft.workflow?.kind !== "lightloop") throw new Error("expected a lightloop workflow")
        draft.workflow.status = "completed"
      })

      expect(SessionNav.deriveSessionIdentity(await Session.get(session.id)).workflow).toEqual({
        kind: "lightloop",
        active: false,
      })

      await Session.remove(session.id)
    })
  })

  test("reports other workflow kinds and unregistered kinds as inactive", async () => {
    await withScope(async () => {
      const plan = await Session.create({ title: "Plan" })
      await WorkflowSessionService.enablePlan(plan.id)
      expect(SessionNav.deriveSessionIdentity(await Session.get(plan.id)).workflow).toEqual({
        kind: "plan",
        active: false,
      })

      await Session.update(plan.id, (draft) => {
        draft.workflow = { kind: "extension", extension: { kind: "unregistered_kind" } }
      })
      expect(SessionNav.deriveSessionIdentity(await Session.get(plan.id)).workflow).toEqual({
        kind: "unregistered_kind",
        active: false,
      })

      const plain = await Session.create({ title: "Plain" })
      expect(SessionNav.deriveSessionIdentity(await Session.get(plain.id)).workflow).toBeUndefined()

      await Session.remove(plan.id)
      await Session.remove(plain.id)
    })
  })

  test("both nav producers agree on the Light Loop identity of a session", async () => {
    await withScope(async (scopeID) => {
      const session = await Session.create({ title: "Active Light Loop" })
      await WorkflowSessionService.startLightloop(session.id, "Ship the feature")

      const live = (await SessionNav.readNavIndex(scopeID)).entries.find((entry) => entry.id === session.id)
      const rebuilt = (await SessionNav.buildNavIndex(scopeID)).entries.find((entry) => entry.id === session.id)
      expect(live?.workflow).toEqual({ kind: "lightloop", active: true })
      expect(rebuilt?.workflow).toEqual(live?.workflow)

      await Session.remove(session.id)
    })
  })
})
