import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { LatticeActionService } from "../../src/lattice/action-service"
import { LatticeController } from "../../src/lattice/controller"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeModelCalls } from "../../src/lattice/model-calls"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeTypes } from "../../src/lattice/types"
import { BlueprintLoopStore } from "../../src/blueprint"
import type { Info as BlueprintLoopInfo } from "../../src/blueprint/types"
import { NoteStore } from "../../src/note"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../fixture/fixture"

setDefaultTimeout(30_000)

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  const request = SessionDrive.request
  ;(SessionDrive.request as any) = async () => false
  try {
    return await ScopeContext.provide({ scope, fn })
  } finally {
    ;(SessionDrive.request as any) = request
    SessionDrive.reset()
  }
}

async function gate(sessionID: string, terminalMessageID = "msg_terminal") {
  return {
    session: await Session.get(sessionID),
    scopeID: ScopeContext.current.scope.id,
    sessionID,
    terminalMessageID,
  }
}

async function attachRecoveryLoop(input: { scopeID: string; runID: string; sessionID: string; sourceDigest: string }) {
  const loop = await BlueprintLoopStore.create({
    noteID: `note_${Identifier.ascending("lattice_step")}`,
    title: "Recovery Loop",
    sessionID: input.sessionID,
    source: "lattice",
    sourceDigest: input.sourceDigest,
  })
  await BlueprintLoopStore.updateStatus(input.scopeID, loop.id, { status: "running" })
  const stepID = Identifier.ascending("lattice_step")
  await LatticeStore.updateByRunID(input.scopeID, input.runID, (draft) => {
    draft.state = "executing"
    draft.currentStepID = stepID
    draft.pathwayRevision++
    draft.pathway = [
      LatticeTypes.Step.parse({
        id: stepID,
        title: "Recover interrupted execution",
        objective: "Converge the persisted BlueprintLoop",
        status: "executing",
        acceptanceCriteria: [],
        assumptions: [],
        blueprintHistory: [],
        loopHistory: [
          {
            loopID: loop.id,
            status: "running",
            sourceDigest: input.sourceDigest,
            time: { created: Date.now(), started: Date.now() },
          },
        ],
        time: { created: Date.now(), updated: Date.now(), started: Date.now() },
      }),
    ]
  })
  return loop
}

async function queueRunInbox(sessionID: string, runID: string, suffix: string, loopID?: string) {
  return SessionInbox.deliverUnique({
    sessionID,
    deliveryKey: `lattice:${runID}:${suffix}`,
    mode: "task",
    message: {
      role: "user",
      metadata: loopID ? { loopID } : undefined,
      parts: [{ type: "text", text: suffix }],
    },
  })
}

describe("LatticeController", () => {
  test("cold start cleans a paused Run and converges its owned Loop without losing the pause reason", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const loop = await attachRecoveryLoop({
        scopeID,
        runID: run.id,
        sessionID: session.id,
        sourceDigest: "paused-owned-digest",
      })
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.pause(draft, "parent_turn_interrupted"),
      )
      await queueRunInbox(session.id, run.id, "prompt:paused")

      await LatticeController.reconcileScope(scopeID, true)

      const recovered = await LatticeStore.getByRunID(scopeID, run.id)
      expect(recovered).toMatchObject({
        status: "paused",
        statusReason: "parent_turn_interrupted",
        pathway: [
          {
            status: "cancelled",
            loopHistory: [{ loopID: loop.id, status: "cancelled" }],
          },
        ],
      })
      expect((await BlueprintLoopStore.get(scopeID, loop.id)).status).toBe("cancelled")
      expect(await SessionInbox.list(session.id)).toEqual([])

      const revision = recovered?.revision
      await LatticeController.reconcileScope(scopeID, true)
      expect((await LatticeStore.getByRunID(scopeID, run.id))?.revision).toBe(revision)
    })
  })

  test("cold start cleans a cancelled Run without reviving it", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const loop = await attachRecoveryLoop({
        scopeID,
        runID: run.id,
        sessionID: session.id,
        sourceDigest: "cancelled-owned-digest",
      })
      const cancelled = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => LatticeMachine.cancel(draft))
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: run.id, mode: run.mode }
      })
      await queueRunInbox(session.id, run.id, "prompt:cancelled")

      await LatticeController.reconcileScope(scopeID, true)

      expect(await LatticeStore.getByRunID(scopeID, run.id)).toMatchObject({
        status: "cancelled",
        revision: cancelled.revision,
      })
      expect((await BlueprintLoopStore.get(scopeID, loop.id)).status).toBe("cancelled")
      expect(await SessionInbox.list(session.id)).toEqual([])
      expect((await Session.get(session.id)).workflow).toBeUndefined()
    })
  })

  test("live final Loop completion clears only its matching Session workflow projection", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const loop = await attachRecoveryLoop({
        scopeID,
        runID: run.id,
        sessionID: session.id,
        sourceDigest: "final-owned-digest",
      })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: run.id, mode: run.mode }
      })
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
        status: "completed",
        summary: "Final Step verified",
      })
      LatticeModelCalls.record(session.id)

      await LatticeController.reconcileDirect(scopeID, session.id, "loop_terminal")

      const completed = await LatticeStore.getByRunID(scopeID, run.id)
      expect(completed).toMatchObject({
        status: "completed",
        modelCallCount: 1,
        pathway: [{ status: "completed", resultSummary: "Final Step verified" }],
      })
      expect((await Session.get(session.id)).workflow).toBeUndefined()

      const revision = completed?.revision
      await LatticeModelCalls.flush(scopeID, session.id)
      await LatticeController.reconcileDirect(scopeID, session.id, "loop_terminal")
      expect((await LatticeStore.getByRunID(scopeID, run.id))?.revision).toBe(revision)
    })
  })

  test("cold start quarantines duplicate Runs while isolating foreign and active Run work", async () => {
    await withScope(async () => {
      const duplicateSession = await Session.create({})
      const activeSession = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const older = await LatticeStore.create({ sessionID: duplicateSession.id, mode: "auto" })
      const olderLoop = await attachRecoveryLoop({
        scopeID,
        runID: older.id,
        sessionID: duplicateSession.id,
        sourceDigest: "older-owned-digest",
      })
      const newer = LatticeTypes.Run.parse({
        schemaVersion: 2,
        id: Identifier.ascending("lattice_run"),
        scopeID,
        sessionID: duplicateSession.id,
        mode: "auto",
        maxModelCalls: 0,
        modelCallCount: 0,
        status: "active",
        state: "clarifying",
        revision: 0,
        stateRevision: 0,
        pathwayRevision: 0,
        pathway: [],
        time: { created: older.time.created + 1, updated: older.time.created + 1 },
      })
      await Storage.write(StoragePath.latticeRun(Identifier.asScopeID(scopeID), newer.id), newer)
      const newerLoop = await attachRecoveryLoop({
        scopeID,
        runID: newer.id,
        sessionID: duplicateSession.id,
        sourceDigest: "newer-owned-digest",
      })
      await Session.update(duplicateSession.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: newer.id, mode: newer.mode }
      })
      const foreignLoop = await BlueprintLoopStore.create({
        noteID: `note_${Identifier.ascending("lattice_step")}`,
        title: "Foreign Loop",
        sessionID: duplicateSession.id,
        source: "user",
        sourceDigest: "foreign-digest",
      })
      await BlueprintLoopStore.updateStatus(scopeID, foreignLoop.id, { status: "running" })

      const active = await LatticeStore.create({ sessionID: activeSession.id, mode: "auto" })
      const activeLoop = await attachRecoveryLoop({
        scopeID,
        runID: active.id,
        sessionID: activeSession.id,
        sourceDigest: "active-owned-digest",
      })
      await Promise.all([
        queueRunInbox(duplicateSession.id, older.id, "prompt:older"),
        queueRunInbox(duplicateSession.id, newer.id, "prompt:newer"),
        queueRunInbox(activeSession.id, active.id, "prompt:active", activeLoop.id),
      ])

      await LatticeController.reconcileScope(scopeID, true)

      expect(await LatticeStore.getByRunID(scopeID, older.id)).toMatchObject({
        status: "failed",
        statusReason: "duplicate_active_run",
        pathway: [
          {
            status: "failed",
            failureReason: "duplicate_active_run",
            loopHistory: [{ status: "cancelled" }],
          },
        ],
      })
      expect(await LatticeStore.getByRunID(scopeID, newer.id)).toMatchObject({
        status: "paused",
        statusReason: "duplicate_active_run",
      })
      expect((await BlueprintLoopStore.get(scopeID, olderLoop.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(scopeID, newerLoop.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(scopeID, foreignLoop.id)).status).toBe("running")
      expect((await BlueprintLoopStore.get(scopeID, activeLoop.id)).status).toBe("running")
      expect((await Session.get(duplicateSession.id)).workflow).toEqual({
        kind: "lattice",
        runID: newer.id,
        mode: newer.mode,
      })
      expect((await SessionInbox.list(duplicateSession.id)).map((item) => item.deliveryKey)).toEqual([])
      expect((await SessionInbox.list(activeSession.id)).map((item) => item.deliveryKey)).toContain(
        `lattice:${active.id}:prompt:active`,
      )
    })
  })

  test("repairs an interrupted enable projection before delivering the durable entry", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeStore.create({ sessionID: session.id, mode: "collaborative", goal: "Recover" })
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry" }),
      )

      await LatticeController.reconcileDirect(scopeID, session.id, "startup")

      expect((await Session.get(session.id)).workflow).toEqual({
        kind: "lattice",
        runID: run.id,
        mode: "collaborative",
      })
      expect(await SessionInbox.list(session.id)).toHaveLength(1)
    })
  })

  test("pauses instead of driving when another workflow owns the Session projection", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "plan" }
      })
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto", goal: "Do not drive" })
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry" }),
      )

      await LatticeController.reconcileDirect(scopeID, session.id, "startup")

      expect(await LatticeStore.getByRunID(scopeID, run.id)).toMatchObject({
        status: "paused",
        statusReason: "workflow_projection_conflict",
      })
      expect(await SessionInbox.list(session.id)).toEqual([])
    })
  })

  test("consumes a persisted action and persists the next state-entry effect before proposing it", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const created = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_requirements", goal: "Deliver", successCriteria: ["verified"] },
      })

      const proposal = await LatticeController.reconcileGate(await gate(session.id))
      const run = await LatticeStore.get(scopeID, session.id)

      expect(run.state).toBe("planning")
      expect(run.pendingAction).toBeUndefined()
      expect(run.effect?.kind).toBe("deliver_prompt")
      expect(run.effect?.id).toBeDefined()
      expect(run.effect?.kind === "deliver_prompt" ? run.effect.deliveryKey : "").toBe(
        `lattice:${created.id}:prompt:${run.effect?.id}`,
      )
      expect(proposal?.kind).toBe("inbox")
      expect(proposal?.kind === "inbox" ? proposal.deliveryKey : undefined).toBe(
        run.effect?.kind === "deliver_prompt" ? run.effect.deliveryKey : undefined,
      )
    })
  })

  test("turns an invalid action into a durable repair effect without a partial transition", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const created = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: created.id, mode: created.mode }
      })
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_requirements", goal: "Deliver", successCriteria: ["verified"] },
      })
      await LatticeController.reconcileGate(await gate(session.id))
      await LatticeStore.update(scopeID, session.id, (draft) => LatticeMachine.completeEffect(draft, draft.effect!.id))
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_pathway", reason: "ready" },
      })

      const proposal = await LatticeController.reconcileGate(await gate(session.id, "msg_next"))
      const run = await LatticeStore.get(scopeID, session.id)

      expect(run.state).toBe("planning")
      expect(run.pendingAction).toBeUndefined()
      expect(run.effect?.kind).toBe("deliver_prompt")
      expect(run.effect?.kind === "deliver_prompt" ? run.effect.promptType : undefined).toBe("repair")
      expect(run.effect?.kind === "deliver_prompt" ? run.effect.validationErrors?.[0] : undefined).toContain("Pathway")
      expect(proposal?.kind).toBe("inbox")
    })
  })

  test("turns a persisted Blueprint action whose Note became unavailable into a durable repair", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        const now = Date.now()
        draft.state = "blueprinting"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Blueprint",
            objective: "Bind a durable Blueprint",
            status: "current",
            acceptanceCriteria: [],
            assumptions: [],
            blueprintHistory: [],
            loopHistory: [],
            time: { created: now, updated: now },
          }),
        ]
      })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: run.id, mode: run.mode }
      })
      const note = await NoteStore.create({ title: "Ephemeral Blueprint", kind: "blueprint" })
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_blueprint", blueprintID: note.id },
      })
      await NoteStore.archive(scopeID, [note.id])

      await LatticeController.reconcileDirect(scopeID, session.id, "action")

      const repaired = await LatticeStore.getByRunID(scopeID, run.id)
      expect(repaired?.status).toBe("active")
      expect(repaired?.state).toBe("blueprinting")
      expect(repaired?.pendingAction).toBeUndefined()
      expect(repaired?.effect).toMatchObject({
        kind: "deliver_prompt",
        promptType: "repair",
        validationErrors: [expect.stringContaining("unavailable")],
      })
    })
  })

  test("persists create and start handoffs and returns to Pathway review after a successful Step", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const created = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: created.id, mode: created.mode }
      })

      const submit = async (input: Parameters<typeof LatticeActionService.submit>[0]["input"]) => {
        await LatticeActionService.submit({ scopeID, sessionID: session.id, source: "agent", input })
        await LatticeController.reconcileGate(await gate(session.id))
      }
      const clearPrompt = async () => {
        await LatticeStore.update(scopeID, session.id, (draft) =>
          LatticeMachine.completeEffect(draft, draft.effect!.id),
        )
      }

      await submit({ action: "submit_requirements", goal: "Deliver", successCriteria: ["verified"] })
      await clearPrompt()
      await LatticeStore.update(scopeID, session.id, (draft) =>
        LatticeMachine.writePathway(draft, [
          { title: "First", objective: "first objective" },
          { title: "Second", objective: "second objective" },
        ]),
      )
      await submit({ action: "submit_pathway", reason: "complete" })
      await clearPrompt()
      await submit({ action: "submit_pathway_review", reason: "reviewed" })
      await clearPrompt()

      const note = await NoteStore.create({ title: "First Blueprint", kind: "blueprint" })
      await submit({ action: "submit_blueprint", blueprintID: note.id })
      await clearPrompt()
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_blueprint_review", reason: "reviewed" },
      })
      let run = await LatticeStore.update(scopeID, session.id, (draft) => LatticeMachine.consumePendingAction(draft))
      if (run.effect?.kind !== "create_blueprint_loop") throw new Error("expected create effect")
      const createEffect = run.effect
      const loop = await BlueprintLoopStore.create({
        noteID: createEffect.blueprintNoteID,
        noteVersion: createEffect.blueprintVersion,
        title: run.pathway[0].title,
        sessionID: session.id,
        source: "lattice",
        sourceDigest: createEffect.sourceDigest,
      })
      run = await LatticeStore.update(scopeID, session.id, (draft) =>
        LatticeMachine.onLoopCreated(draft, {
          loopID: loop.id,
          blueprintVersion: createEffect.blueprintVersion + 1,
          sourceDigest: createEffect.sourceDigest,
        }),
      )
      await Storage.update<BlueprintLoopInfo>(
        StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), loop.id),
        (draft) => {
          draft.status = "running"
          draft.time.started = Date.now()
          draft.time.updated = Date.now()
        },
      )
      run = await LatticeStore.update(scopeID, session.id, (draft) => LatticeMachine.onLoopStarted(draft, loop.id))
      const attempt = run.pathway[0].loopHistory[0]
      expect(run.state).toBe("executing")
      expect(run.effect).toBeUndefined()
      expect(run.pathway[0].status).toBe("executing")
      expect(attempt?.status).toBe("running")

      await Storage.update<BlueprintLoopInfo>(
        StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), loop.id),
        (draft) => {
          draft.status = "completed"
          draft.summary = "First Step verified"
          draft.time.completed = Date.now()
          draft.time.updated = Date.now()
        },
      )
      await LatticeController.reconcileDirect(scopeID, session.id, "loop_terminal")
      run = await LatticeStore.get(scopeID, session.id)

      expect(run.status).toBe("active")
      expect(run.state).toBe("reviewing_pathway")
      expect(run.currentStepID).toBeUndefined()
      expect(run.pathway.map((step) => step.status)).toEqual(["completed", "pending"])
      expect(run.pathway[0].resultSummary).toBe("First Step verified")
      expect(run.effect?.kind).toBe("deliver_prompt")
    })
  })

  test("revalidates Blueprint version as well as content before starting an armed Loop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const created = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: created.id, mode: created.mode }
      })

      const submit = async (input: Parameters<typeof LatticeActionService.submit>[0]["input"]) => {
        await LatticeActionService.submit({ scopeID, sessionID: session.id, source: "agent", input })
        await LatticeController.reconcileGate(await gate(session.id))
      }
      const clearPrompt = async () => {
        await LatticeStore.update(scopeID, session.id, (draft) =>
          LatticeMachine.completeEffect(draft, draft.effect!.id),
        )
      }

      await submit({ action: "submit_requirements", goal: "Deliver", successCriteria: ["verified"] })
      await clearPrompt()
      await LatticeStore.update(scopeID, session.id, (draft) =>
        LatticeMachine.writePathway(draft, [{ title: "Only", objective: "only objective" }]),
      )
      await submit({ action: "submit_pathway", reason: "complete" })
      await clearPrompt()
      await submit({ action: "submit_pathway_review", reason: "reviewed" })
      await clearPrompt()

      const note = await NoteStore.create({ title: "Only Blueprint", kind: "blueprint" })
      await submit({ action: "submit_blueprint", blueprintID: note.id })
      await clearPrompt()
      await LatticeActionService.submit({
        scopeID,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_blueprint_review", reason: "reviewed" },
      })
      let run = await LatticeStore.update(scopeID, session.id, (draft) => LatticeMachine.consumePendingAction(draft))
      if (run.effect?.kind !== "create_blueprint_loop") throw new Error("expected create effect")
      const createEffect = run.effect
      const loop = await BlueprintLoopStore.create({
        noteID: createEffect.blueprintNoteID,
        noteVersion: createEffect.blueprintVersion,
        title: run.pathway[0].title,
        sessionID: session.id,
        source: "lattice",
        sourceDigest: createEffect.sourceDigest,
      })
      run = await LatticeStore.update(scopeID, session.id, (draft) =>
        LatticeMachine.onLoopCreated(draft, {
          loopID: loop.id,
          blueprintVersion: createEffect.blueprintVersion + 1,
          sourceDigest: createEffect.sourceDigest,
        }),
      )
      expect(run.effect?.kind).toBe("start_blueprint_loop")

      const linkedNote = await NoteStore.getAny(scopeID, note.id)
      const updatedNote = await NoteStore.update(scopeID, note.id, { expectedVersion: linkedNote.version })
      await LatticeController.reconcileDirect(scopeID, session.id, "action")

      run = await LatticeStore.get(scopeID, session.id)
      const cancelledLoop = await BlueprintLoopStore.get(scopeID, loop.id)
      expect(updatedNote.version).toBe(linkedNote.version + 1)
      expect(run.state).toBe("reviewing_blueprint")
      expect(run.pathway[0].status).toBe("current")
      expect(run.pathway[0].blueprint?.boundVersion).toBe(updatedNote.version)
      expect(run.effect?.kind).toBe("deliver_prompt")
      expect(cancelledLoop.status).toBe("cancelled")
    })
  })
})
