import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { BlueprintLoopService, BlueprintLoopStore } from "../../src/blueprint"
import { Identifier } from "../../src/id/id"
import { LatticeActionService } from "../../src/lattice/action-service"
import { LatticeController } from "../../src/lattice/controller"
import { LatticeError } from "../../src/lattice/error"
import { LatticeLock } from "../../src/lattice/lock"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeModelCalls } from "../../src/lattice/model-calls"
import { LatticeRunService } from "../../src/lattice/run-service"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeTypes } from "../../src/lattice/types"
import { NoteDocument, NoteStore } from "../../src/note"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { SessionWorkflowService } from "../../src/session/workflow"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
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

async function complete(runID: string): Promise<void> {
  await LatticeStore.updateByRunID(ScopeContext.current.scope.id, runID, (draft) => {
    draft.status = "completed"
    draft.time.completed = Date.now()
  })
}

async function attachRunningLoop(runID: string, sessionID: string) {
  const loop = await BlueprintLoopStore.create({
    noteID: `note_${Identifier.ascending("lattice_step")}`,
    title: "Owned loop",
    sessionID,
    source: "lattice",
    sourceDigest: "digest-owned",
  })
  await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
  const stepID = Identifier.ascending("lattice_step")
  await LatticeStore.updateByRunID(ScopeContext.current.scope.id, runID, (draft) => {
    draft.state = "executing"
    draft.currentStepID = stepID
    draft.pathwayRevision = 1
    draft.pathway = [
      LatticeTypes.Step.parse({
        id: stepID,
        title: "Execute",
        objective: "Run the owned Blueprint",
        status: "executing",
        acceptanceCriteria: [],
        assumptions: [],
        blueprintHistory: [],
        loopHistory: [
          {
            loopID: loop.id,
            status: "running",
            sourceDigest: "digest-owned",
            time: { created: Date.now(), started: Date.now() },
          },
        ],
        time: { created: Date.now(), updated: Date.now(), started: Date.now() },
      }),
    ]
  })
  return loop
}

async function armCreateEffect(runID: string, title = "Crash-window Blueprint") {
  const scopeID = ScopeContext.current.scope.id
  const note = await NoteStore.create({ title, kind: "blueprint" })
  const sourceDigest = NoteDocument.hash(note.content)
  const stepID = Identifier.ascending("lattice_step")
  const run = await LatticeStore.updateByRunID(scopeID, runID, (draft) => {
    const now = Date.now()
    draft.state = "executing"
    draft.currentStepID = stepID
    draft.pathwayRevision++
    draft.pathway = [
      LatticeTypes.Step.parse({
        id: stepID,
        title,
        objective: "Recover an interrupted BlueprintLoop create handoff",
        status: "current",
        acceptanceCriteria: [],
        assumptions: [],
        blueprint: {
          noteID: note.id,
          boundVersion: note.version,
          contentDigest: sourceDigest,
          reviewedVersion: note.version,
          reviewedContentDigest: sourceDigest,
          time: { bound: now, reviewed: now },
        },
        blueprintHistory: [],
        loopHistory: [],
        time: { created: now, updated: now },
      }),
    ]
    draft.effect = {
      id: Identifier.ascending("lattice_effect"),
      kind: "create_blueprint_loop",
      stepID,
      blueprintNoteID: note.id,
      blueprintVersion: note.version,
      sourceDigest,
      time: { created: now },
    }
  })
  if (run.effect?.kind !== "create_blueprint_loop") throw new Error("expected create effect")
  return { run, note, effect: run.effect }
}

describe("LatticeRunService v2", () => {
  test("workflow enable projects only kind, runID, and mode", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const after = await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)

      expect(run.status).toBe("active")
      expect(run.state).toBe("clarifying")
      expect(after.workflow).toEqual({ kind: "lattice", runID: run.id, mode: "auto" })
    })
  })

  test("enable updates mode and budget on the same active run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const updated = await LatticeRunService.enable({
        sessionID: session.id,
        mode: "collaborative",
        maxModelCalls: 5,
      })

      expect(updated.id).toBe(first.id)
      expect(updated.mode).toBe("collaborative")
      expect(updated.maxModelCalls).toBe(5)
      expect(await LatticeStore.list(ScopeContext.current.scope.id)).toHaveLength(1)
    })
  })

  test("explicit resume extends an exhausted soft budget by exactly one model call", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto", maxModelCalls: 1 })
      await LatticeStore.updateByRunID(run.scopeID, run.id, (draft) => {
        draft.modelCallCount = 1
        return LatticeMachine.markBudgetExhausted(draft)
      })

      const resumed = await LatticeRunService.resume(run.id)

      expect(resumed.status).toBe("active")
      expect(resumed.statusReason).toBeUndefined()
      expect(resumed.modelCallCount).toBe(1)
      expect(resumed.maxModelCalls).toBe(2)
    })
  })

  test("a paused run requires explicit resume and resumes the same run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeRunService.pause(first.id)

      await expect(LatticeRunService.enable({ sessionID: session.id, mode: "auto" })).rejects.toMatchObject({
        data: { reason: expect.stringContaining("explicit resume") },
      })
      const resumed = await LatticeRunService.resume(first.id)

      expect(resumed.id).toBe(first.id)
      expect(resumed.status).toBe("active")
      expect(await LatticeStore.list(ScopeContext.current.scope.id)).toHaveLength(1)
    })
  })

  test("only a terminal current run permits a new run and preserves history", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await complete(first.id)
      const second = await LatticeRunService.enable({ sessionID: session.id, mode: "collaborative" })

      expect(second.id).not.toBe(first.id)
      expect((await LatticeStore.getByRunID(ScopeContext.current.scope.id, first.id))?.status).toBe("completed")
      expect((await LatticeStore.list(ScopeContext.current.scope.id)).map((run) => run.id)).toEqual([
        first.id,
        second.id,
      ])
    })
  })

  test("goal enable persists before the workflow projection delivers one clarifying entry", async () => {
    await withScope(async () => {
      const directSession = await Session.create({})
      const persisted = await LatticeRunService.enable({
        sessionID: directSession.id,
        mode: "auto",
        goal: "Persist first",
      })
      expect(persisted.effect?.kind).toBe("deliver_prompt")
      expect(await SessionInbox.list(directSession.id)).toEqual([])

      const session = await Session.create({})
      const projected = await SessionWorkflowService.enableLattice(session.id, {
        kind: "lattice",
        mode: "auto",
        goal: "Ship safely",
      })
      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)
      const entries = (await SessionInbox.list(session.id)).filter((item) =>
        item.deliveryKey?.startsWith(`lattice:${run.id}:prompt:`),
      )

      expect(projected.workflow).toEqual({ kind: "lattice", runID: run.id, mode: "auto" })
      expect(entries).toHaveLength(1)
      expect(entries[0].deliveryKey).toBe(
        run.effect?.kind === "deliver_prompt" ? run.effect.deliveryKey : entries[0].deliveryKey,
      )
      await SessionWorkflowService.enableLattice(session.id, {
        kind: "lattice",
        mode: "auto",
        goal: "Ignored duplicate seed",
      })
      expect(
        (await SessionInbox.list(session.id)).filter((item) =>
          item.deliveryKey?.startsWith(`lattice:${run.id}:prompt:`),
        ),
      ).toHaveLength(1)
    })
  })

  test("pause persists first, removes only this run's inbox entries, and cancels only its owned loop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const owned = await attachRunningLoop(run.id, session.id)
      const unrelated = await BlueprintLoopStore.create({
        noteID: "note_unrelated",
        title: "Unrelated loop",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "digest-unrelated",
      })
      await SessionInbox.deliverUnique({
        sessionID: session.id,
        deliveryKey: `lattice:${run.id}:prompt:test`,
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "owned" }] },
      })
      await SessionInbox.deliverUnique({
        sessionID: session.id,
        deliveryKey: "other:keep",
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "keep" }] },
      })

      const paused = await LatticeRunService.pause(run.id)

      expect(paused.status).toBe("paused")
      expect(paused.statusReason).toBe("user_paused")
      expect((await SessionInbox.list(session.id)).map((item) => item.deliveryKey)).toEqual(["other:keep"])
      expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, owned.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, unrelated.id)).status).toBe("armed")
    })
  })

  test("pause does not cancel a same-session Lattice Loop with a mismatched ownership digest", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const loop = await attachRunningLoop(run.id, session.id)
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        draft.pathway[0].loopHistory[0].sourceDigest = "digest-corrupted"
      })

      const paused = await LatticeRunService.pause(run.id)
      const untouched = await BlueprintLoopStore.get(scopeID, loop.id)

      expect(paused.status).toBe("paused")
      expect(untouched.status).toBe("running")
    })
  })

  test("pause waits for an in-flight Loop create handoff and leaves no armed orphan", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: run.id, mode: run.mode }
      })
      const note = await NoteStore.create({ title: "Race Blueprint", kind: "blueprint" })
      const digest = NoteDocument.hash(note.content)
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        draft.state = "executing"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Race",
            objective: "Exercise lifecycle serialization",
            status: "current",
            acceptanceCriteria: [],
            assumptions: [],
            blueprint: {
              noteID: note.id,
              boundVersion: note.version,
              contentDigest: digest,
              reviewedVersion: note.version,
              reviewedContentDigest: digest,
              time: { bound: Date.now(), reviewed: Date.now() },
            },
            blueprintHistory: [],
            loopHistory: [],
            time: { created: Date.now(), updated: Date.now() },
          }),
        ]
        draft.effect = {
          id: Identifier.ascending("lattice_effect"),
          kind: "create_blueprint_loop",
          stepID,
          blueprintNoteID: note.id,
          blueprintVersion: note.version,
          sourceDigest: digest,
          time: { created: Date.now() },
        }
      })

      const create = BlueprintLoopService.create
      let releaseCreate!: () => void
      let markCreated!: () => void
      const created = new Promise<void>((resolve) => {
        markCreated = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      ;(BlueprintLoopService.create as any) = async (...args: Parameters<typeof BlueprintLoopService.create>) => {
        const loop = await create(...args)
        markCreated()
        await release
        return loop
      }

      try {
        const reconcile = LatticeController.reconcileDirect(scopeID, session.id, "action")
        await created
        const pause = LatticeRunService.pause(run.id)
        releaseCreate()
        await Promise.all([reconcile, pause])
      } finally {
        ;(BlueprintLoopService.create as any) = create
        releaseCreate?.()
      }

      const paused = await LatticeStore.getByRunID(scopeID, run.id)
      const loops = await BlueprintLoopStore.list(scopeID)
      expect(paused?.status).toBe("paused")
      expect(loops).toHaveLength(1)
      expect(loops[0].status).toBe("cancelled")
    })
  })

  test("pause cancels every exact orphan created before the persisted lifecycle transition", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const enabled = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const { effect } = await armCreateEffect(enabled.id)
      const first = await BlueprintLoopStore.create({
        noteID: effect.blueprintNoteID,
        noteVersion: effect.blueprintVersion,
        title: "First orphan",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: effect.sourceDigest,
      })
      const second = {
        ...first,
        id: Identifier.ascending("blueprint_loop"),
        title: "Second orphan",
        time: { ...first.time },
      }
      await Storage.write(StoragePath.blueprintLoop(Identifier.asScopeID(enabled.scopeID), second.id), second)

      const paused = await LatticeRunService.pause(enabled.id)

      expect(paused.status).toBe("paused")
      expect(paused.effect).toBeUndefined()
      expect((await BlueprintLoopStore.get(enabled.scopeID, first.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(enabled.scopeID, second.id)).status).toBe("cancelled")
      const resumed = await LatticeRunService.resume(enabled.id)
      expect(resumed.state).toBe("blueprinting")
    })
  })

  test("pause cancels all recorded owned Loops while leaving a foreign Loop untouched", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const first = await BlueprintLoopStore.create({
        noteID: "note_owned_first",
        title: "First owned",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "digest-first",
      })
      const second = await BlueprintLoopStore.create({
        noteID: "note_owned_second",
        title: "Second owned",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "digest-second",
      })
      const foreign = await BlueprintLoopStore.create({
        noteID: "note_foreign",
        title: "Foreign",
        sessionID: session.id,
        source: "plugin",
        sourceDigest: "digest-foreign",
      })
      await BlueprintLoopStore.updateStatus(run.scopeID, first.id, { status: "running" })
      await BlueprintLoopStore.updateStatus(run.scopeID, second.id, { status: "running" })
      await BlueprintLoopStore.updateStatus(run.scopeID, foreign.id, { status: "running" })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(run.scopeID, run.id, (draft) => {
        const now = Date.now()
        draft.state = "executing"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Conflicted ownership",
            objective: "Converge all owned work",
            status: "executing",
            acceptanceCriteria: [],
            assumptions: [],
            blueprintHistory: [],
            loopHistory: [
              { loopID: first.id, status: "running", sourceDigest: "digest-first", time: { created: now } },
              { loopID: second.id, status: "running", sourceDigest: "digest-second", time: { created: now } },
              { loopID: foreign.id, status: "running", sourceDigest: "not-foreign-digest", time: { created: now } },
            ],
            time: { created: now, updated: now, started: now },
          }),
        ]
      })

      await LatticeRunService.pause(run.id)

      expect((await BlueprintLoopStore.get(run.scopeID, first.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(run.scopeID, second.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(run.scopeID, foreign.id)).status).toBe("running")
    })
  })

  test("record-key corruption cannot redirect lifecycle cleanup to another Loop id", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const canonical = await BlueprintLoopStore.create({
        noteID: "note_canonical",
        title: "Canonical Loop",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "same-digest",
      })
      await BlueprintLoopStore.updateStatus(run.scopeID, canonical.id, { status: "running" })
      const corruptKey = Identifier.ascending("blueprint_loop")
      await Storage.write(StoragePath.blueprintLoop(Identifier.asScopeID(run.scopeID), corruptKey), {
        ...canonical,
        status: "running",
      })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(run.scopeID, run.id, (draft) => {
        const now = Date.now()
        draft.state = "executing"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Corrupt reference",
            objective: "Do not follow a mismatched stored id",
            status: "executing",
            acceptanceCriteria: [],
            assumptions: [],
            blueprintHistory: [],
            loopHistory: [
              { loopID: corruptKey, status: "running", sourceDigest: "same-digest", time: { created: now } },
            ],
            time: { created: now, updated: now, started: now },
          }),
        ]
      })

      await LatticeRunService.pause(run.id)

      expect((await BlueprintLoopStore.get(run.scopeID, canonical.id)).status).toBe("running")
    })
  })

  test("retrying pause completes cleanup after a crash immediately after persistence", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) =>
        LatticeMachine.pause(draft, "user_paused"),
      )
      await SessionInbox.deliverUnique({
        sessionID: session.id,
        deliveryKey: `lattice:${run.id}:prompt:interrupted-pause`,
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "remove on retry" }] },
      })

      const paused = await LatticeRunService.pause(run.id)

      expect(paused.status).toBe("paused")
      expect(await SessionInbox.list(session.id)).toEqual([])
    })
  })

  test("resume consumes a still-valid pending action instead of creating a duplicate entry", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeActionService.submit({
        scopeID: ScopeContext.current.scope.id,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_requirements", goal: "Build", successCriteria: ["done"] },
      })
      await LatticeRunService.pause(run.id)

      const resumed = await LatticeRunService.resume(run.id)

      expect(resumed.status).toBe("active")
      expect(resumed.state).toBe("planning")
      expect(resumed.requirements?.goal).toBe("Build")
      expect(resumed.pendingAction).toBeUndefined()
    })
  })

  test("explicit resume re-drives an active interrupted parent state exactly once", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })

      const first = await LatticeRunService.resume(run.id)
      const second = await LatticeRunService.resume(run.id)
      const entries = (await SessionInbox.list(session.id)).filter((item) =>
        item.deliveryKey?.startsWith(`lattice:${run.id}:prompt:`),
      )

      expect(first.status).toBe("active")
      expect(second.id).toBe(run.id)
      expect(entries).toHaveLength(1)
    })
  })

  test("active resume serializes prompt preparation before handing off to the Controller", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const reconcile = LatticeController.reconcileDirect
      const lock = spyOn(LatticeLock, "write")
      ;(LatticeController.reconcileDirect as any) = async () => undefined

      try {
        await LatticeRunService.resume(run.id)
        expect(lock).toHaveBeenCalledWith(scopeID, session.id)
      } finally {
        ;(LatticeController.reconcileDirect as any) = reconcile
        lock.mockRestore()
      }
    })
  })

  test("active resume re-arms a prompt that was materialized by a failed parent turn", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
        LatticeMachine.setPromptEffect(draft, { promptType: "state_entry" }),
      )
      await LatticeController.reconcileDirect(scopeID, session.id, "action")

      const delivered = await LatticeStore.getByRunID(scopeID, run.id)
      if (delivered?.effect?.kind !== "deliver_prompt") throw new Error("expected delivered prompt effect")
      const oldDeliveryKey = delivered.effect.deliveryKey
      const oldItem = (await SessionInbox.list(session.id)).find((item) => item.deliveryKey === oldDeliveryKey)
      if (!oldItem) throw new Error("expected queued prompt")
      await SessionInbox.materializeItem(oldItem)
      await SessionInbox.remove({ sessionID: session.id, itemID: oldItem.id })

      const resumed = await LatticeRunService.resume(run.id)
      if (resumed.effect?.kind !== "deliver_prompt") throw new Error("expected re-armed prompt effect")
      const queued = await SessionInbox.list(session.id)

      expect(resumed.effect.promptType).toBe("resume")
      expect(resumed.effect.deliveryKey).not.toBe(oldDeliveryKey)
      expect(queued.map((item) => item.deliveryKey)).toEqual([resumed.effect.deliveryKey])
    })
  })

  test("active resume converges an existing action instead of adding a second prompt", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeActionService.submit({
        scopeID: ScopeContext.current.scope.id,
        sessionID: session.id,
        source: "agent",
        input: { action: "submit_requirements", goal: "Build", successCriteria: ["done"] },
      })

      const resumed = await LatticeRunService.resume(run.id)
      const entries = (await SessionInbox.list(session.id)).filter((item) =>
        item.deliveryKey?.startsWith(`lattice:${run.id}:prompt:`),
      )

      expect(resumed.state).toBe("planning")
      expect(resumed.requirements?.goal).toBe("Build")
      expect(entries).toHaveLength(1)
    })
  })

  test("active resume never injects work while awaiting collaborative approval", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "collaborative" })
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) => {
        draft.state = "awaiting_execution"
      })

      const resumed = await LatticeRunService.resume(run.id)

      expect(resumed.state).toBe("awaiting_execution")
      expect(resumed.effect).toBeUndefined()
      expect(await SessionInbox.list(session.id)).toEqual([])

      await LatticeRunService.pause(run.id)
      const resumedFromPause = await LatticeRunService.resume(run.id)
      expect(resumedFromPause.state).toBe("awaiting_execution")
      expect(resumedFromPause.effect).toBeUndefined()
      expect(await SessionInbox.list(session.id)).toEqual([])
    })
  })

  test("active resume rejects an executing Run with a live BlueprintLoop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await attachRunningLoop(run.id, session.id)

      await expect(LatticeRunService.resume(run.id)).rejects.toMatchObject({
        data: { reason: expect.stringContaining("BlueprintLoop") },
      })
    })
  })

  test("active resume replays a persisted start effect even while its armed Loop exists", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const loop = await BlueprintLoopStore.create({
        noteID: "note_armed",
        title: "Armed loop",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "digest-armed",
      })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) => {
        draft.state = "executing"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Execute",
            objective: "Start the armed loop",
            status: "executing",
            acceptanceCriteria: [],
            assumptions: [],
            blueprintHistory: [],
            loopHistory: [
              {
                loopID: loop.id,
                status: "created",
                sourceDigest: "digest-armed",
                time: { created: Date.now() },
              },
            ],
            time: { created: Date.now(), updated: Date.now(), started: Date.now() },
          }),
        ]
        draft.effect = {
          id: Identifier.ascending("lattice_effect"),
          kind: "start_blueprint_loop",
          stepID,
          loopID: loop.id,
          blueprintVersion: 1,
          sourceDigest: "digest-armed",
          time: { created: Date.now() },
        }
      })
      const reconcile = LatticeController.reconcileDirect
      let calls = 0
      ;(LatticeController.reconcileDirect as any) = async () => {
        calls++
      }
      try {
        const resumed = await LatticeRunService.resume(run.id)
        expect(resumed.id).toBe(run.id)
      } finally {
        ;(LatticeController.reconcileDirect as any) = reconcile
      }
      expect(calls).toBe(1)
    })
  })

  test("panel approval submits only the fixed semantic approval action", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "collaborative" })
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) => {
        draft.state = "awaiting_execution"
      })
      const submit = LatticeActionService.submit
      const reconcile = LatticeController.reconcileDirect
      let captured: Parameters<typeof LatticeActionService.submit>[0] | undefined
      ;(LatticeActionService.submit as any) = async (input: Parameters<typeof LatticeActionService.submit>[0]) => {
        captured = input
        return (await LatticeStore.getByRunID(input.scopeID, run.id))!
      }
      let reconcileCalls = 0
      ;(LatticeController.reconcileDirect as any) = async () => {
        reconcileCalls++
        if (reconcileCalls === 1) return
        await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) => {
          draft.state = "executing"
        })
      }

      try {
        await LatticeRunService.approve(run.id)
      } finally {
        ;(LatticeActionService.submit as any) = submit
        ;(LatticeController.reconcileDirect as any) = reconcile
      }

      expect(captured).toEqual({
        scopeID: ScopeContext.current.scope.id,
        sessionID: session.id,
        source: "panel",
        input: { action: "approve_execution", reason: "Approved in Lattice Panel" },
      })
    })
  })

  test("approval revalidates a changed Blueprint even when its Bus event was lost", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const note = await NoteStore.create({ title: "Reviewed Blueprint", kind: "blueprint" })
      const digest = NoteDocument.hash(note.content)
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "collaborative" })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(scopeID, run.id, (draft) => {
        const now = Date.now()
        draft.state = "awaiting_execution"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Execute reviewed Blueprint",
            objective: "Reject stale approval",
            status: "current",
            acceptanceCriteria: [],
            assumptions: [],
            blueprint: {
              noteID: note.id,
              boundVersion: note.version,
              contentDigest: digest,
              reviewedVersion: note.version,
              reviewedContentDigest: digest,
              time: { bound: now, reviewed: now },
            },
            blueprintHistory: [],
            loopHistory: [],
            time: { created: now, updated: now },
          }),
        ]
      })
      await NoteStore.update(scopeID, note.id, { expectedVersion: note.version, title: "Changed Blueprint" })

      await expect(LatticeRunService.approve(run.id)).rejects.toBeInstanceOf(LatticeError.StateConflict)

      const repaired = await LatticeStore.getByRunID(scopeID, run.id)
      expect(repaired?.state).toBe("reviewing_blueprint")
      expect(repaired?.pendingAction).toBeUndefined()
      expect(repaired?.effect).toMatchObject({ kind: "deliver_prompt", promptType: "state_entry" })
    })
  })

  test("resume reopens a failed executing Step in blueprinting", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const loop = await attachRunningLoop(run.id, session.id)
      await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
        status: "failed",
        error: "boom",
      })
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) =>
        LatticeMachine.onLoopTerminal(draft, { loopID: loop.id, status: "failed", error: "boom" }),
      )

      const resumed = await LatticeRunService.resume(run.id)

      expect(resumed.status).toBe("active")
      expect(resumed.state).toBe("blueprinting")
      expect(LatticeMachine.currentStep(resumed)?.status).toBe("current")
      expect(LatticeMachine.currentStep(resumed)?.loopHistory.at(-1)?.status).toBe("failed")
    })
  })

  test("resume reopens execution interrupted before BlueprintLoop creation", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) => {
        draft.state = "executing"
        draft.currentStepID = stepID
        draft.pathwayRevision = 1
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Execute",
            objective: "Create the loop",
            status: "current",
            acceptanceCriteria: [],
            assumptions: [],
            blueprint: {
              noteID: "note_interrupted",
              boundVersion: 1,
              contentDigest: "digest-interrupted",
              reviewedVersion: 1,
              reviewedContentDigest: "digest-interrupted",
              time: { bound: Date.now(), reviewed: Date.now() },
            },
            blueprintHistory: [],
            loopHistory: [],
            time: { created: Date.now(), updated: Date.now() },
          }),
        ]
        draft.effect = {
          id: Identifier.ascending("lattice_effect"),
          kind: "create_blueprint_loop",
          stepID,
          blueprintNoteID: "note_interrupted",
          blueprintVersion: 1,
          sourceDigest: "digest-interrupted",
          time: { created: Date.now() },
        }
      })
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) =>
        LatticeMachine.pause(draft, "parent_turn_interrupted"),
      )

      const resumed = await LatticeRunService.resume(run.id)

      expect(resumed.state).toBe("blueprinting")
      expect(LatticeMachine.currentStep(resumed)?.status).toBe("current")
      expect(resumed.effect?.kind).toBe("deliver_prompt")
    })
  })

  test("resume completes an interrupted create cleanup before clearing its durable breadcrumb", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const { effect } = await armCreateEffect(run.id, "Resume cleanup Blueprint")
      const orphan = await BlueprintLoopStore.create({
        noteID: effect.blueprintNoteID,
        noteVersion: effect.blueprintVersion,
        title: "Interrupted orphan",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: effect.sourceDigest,
      })
      await LatticeStore.updateByRunID(run.scopeID, run.id, (draft) =>
        LatticeMachine.pause(draft, "parent_turn_interrupted"),
      )

      const resumed = await LatticeRunService.resume(run.id)

      expect((await BlueprintLoopStore.get(run.scopeID, orphan.id)).status).toBe("cancelled")
      expect(resumed.status).toBe("active")
      expect(resumed.state).toBe("blueprinting")
      expect(resumed.effect?.kind).toBe("deliver_prompt")
    })
  })

  test("one resume reconciles a failed Loop fact after a lost wake and reopens its Step", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const loop = await attachRunningLoop(run.id, session.id)
      await LatticeStore.updateByRunID(run.scopeID, run.id, (draft) =>
        LatticeMachine.pause(draft, "parent_turn_interrupted"),
      )
      await BlueprintLoopStore.updateStatus(run.scopeID, loop.id, { status: "failed", error: "lost wake" })

      const resumed = await LatticeRunService.resume(run.id)

      expect(resumed.status).toBe("active")
      expect(resumed.state).toBe("blueprinting")
      expect(LatticeMachine.currentStep(resumed)?.status).toBe("current")
      expect(LatticeMachine.currentStep(resumed)?.loopHistory.at(-1)).toMatchObject({
        loopID: loop.id,
        status: "failed",
        error: "lost wake",
      })
    })
  })

  test("resume finishes interrupted pause cleanup before reopening a live owned Loop Step", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const loop = await attachRunningLoop(run.id, session.id)
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) =>
        LatticeMachine.pause(draft, "parent_turn_interrupted"),
      )

      const resumed = await LatticeRunService.resume(run.id)

      expect((await BlueprintLoopStore.get(run.scopeID, loop.id)).status).toBe("cancelled")
      expect(resumed.status).toBe("active")
      expect(resumed.state).toBe("blueprinting")
      expect(LatticeMachine.currentStep(resumed)?.status).toBe("current")
    })
  })

  test("cancel is irreversible, preserves the run, and permits a later new run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const cancelled = await LatticeRunService.cancel(first.id)

      expect(cancelled.status).toBe("cancelled")
      await expect(LatticeRunService.resume(first.id)).rejects.toThrow()
      const second = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      expect(second.id).not.toBe(first.id)
      expect((await LatticeStore.getByRunID(ScopeContext.current.scope.id, first.id))?.status).toBe("cancelled")

      await SessionInbox.deliverUnique({
        sessionID: session.id,
        deliveryKey: `lattice:${second.id}:prompt:keep-current`,
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "keep current Run work" }] },
      })
      await LatticeRunService.cancel(first.id)
      expect((await SessionInbox.list(session.id)).map((item) => item.deliveryKey)).toContain(
        `lattice:${second.id}:prompt:keep-current`,
      )
    })
  })

  test("live cancel clears only its matching workflow projection after releasing lifecycle ownership", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const projected = await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      if (projected.workflow?.kind !== "lattice") throw new Error("expected Lattice projection")

      await LatticeRunService.cancel(projected.workflow.runID)

      expect((await Session.get(session.id)).workflow).toBeUndefined()
    })
  })

  test("a terminal Run never leaks pending model calls into its replacement Run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      LatticeModelCalls.record(session.id)

      const cancelled = await LatticeRunService.cancel(first.id)
      const terminalRevision = cancelled.revision
      const second = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeModelCalls.flush(scopeID, session.id)

      expect((await LatticeStore.getByRunID(scopeID, first.id))?.modelCallCount).toBe(1)
      expect((await LatticeStore.getByRunID(scopeID, first.id))?.revision).toBe(terminalRevision)
      expect((await LatticeStore.getByRunID(scopeID, second.id))?.modelCallCount).toBe(0)
    })
  })

  test("cancel revalidates ownership under the lifecycle lock before touching a replacement Run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const scopeID = ScopeContext.current.scope.id
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const write = LatticeLock.write
      let injected = false
      let replacement: LatticeTypes.Run | undefined
      let lease: ReturnType<typeof SessionManager.acquire> | undefined
      const lock = spyOn(LatticeLock, "write").mockImplementation(async (candidateScopeID, candidateSessionID) => {
        const ownership = await write(candidateScopeID, candidateSessionID)
        if (!injected) {
          injected = true
          const completedAt = Date.now()
          await Storage.write(StoragePath.latticeRun(Identifier.asScopeID(scopeID), first.id), {
            ...first,
            status: "completed",
            time: { ...first.time, updated: completedAt, completed: completedAt },
          })
          replacement = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
          lease = SessionManager.acquire(session.id)
          if (!lease) throw new Error("expected replacement Session lease")
          LatticeModelCalls.record(session.id)
        }
        return ownership
      })

      try {
        await expect(LatticeRunService.cancel(first.id)).rejects.toBeInstanceOf(LatticeError.StateConflict)
        if (!replacement || !lease) throw new Error("expected replacement Run state")
        expect(lease.signal.aborted).toBe(false)
        await LatticeModelCalls.flush(scopeID, session.id)
        expect((await LatticeStore.getByRunID(scopeID, replacement.id))?.modelCallCount).toBe(1)
      } finally {
        lock.mockRestore()
        if (lease) {
          await SessionManager.release(lease, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      }
    })
  })

  test("cancel recovers a create handoff orphan but never cancels a later Run's matching Loop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const { effect } = await armCreateEffect(first.id, "Repeated Blueprint")
      const orphan = await BlueprintLoopStore.create({
        noteID: effect.blueprintNoteID,
        noteVersion: effect.blueprintVersion,
        title: "Old orphan",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: effect.sourceDigest,
      })

      const terminal = await LatticeStore.updateByRunID(first.scopeID, first.id, (draft) =>
        LatticeMachine.cancel(draft),
      )
      expect(terminal.effect?.kind).toBe("create_blueprint_loop")
      await BlueprintLoopStore.updateStatus(first.scopeID, orphan.id, { status: "cancelled" })
      const second = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeStore.updateByRunID(first.scopeID, second.id, (draft) => {
        draft.state = "executing"
        draft.effect = { ...effect, id: Identifier.ascending("lattice_effect"), time: { created: Date.now() } }
      })
      const later = await BlueprintLoopStore.create({
        noteID: effect.blueprintNoteID,
        noteVersion: effect.blueprintVersion,
        title: "New Run loop",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: effect.sourceDigest,
      })

      const cleaned = await LatticeRunService.cleanupInactiveRun(first.scopeID, first.id)

      expect(cleaned?.effect).toBeUndefined()
      expect((await BlueprintLoopStore.get(first.scopeID, later.id)).status).toBe("armed")
    })
  })

  test("cold duplicate quarantine retains create ownership until orphan cleanup succeeds", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const enabled = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const { effect } = await armCreateEffect(enabled.id)
      const orphan = await BlueprintLoopStore.create({
        noteID: effect.blueprintNoteID,
        noteVersion: effect.blueprintVersion,
        title: "Quarantined orphan",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: effect.sourceDigest,
      })
      const quarantined = await LatticeStore.updateByRunID(enabled.scopeID, enabled.id, (draft) =>
        LatticeMachine.quarantineDuplicate(draft, false),
      )
      expect(quarantined.status).toBe("failed")
      expect(quarantined.effect?.kind).toBe("create_blueprint_loop")

      const cleaned = await LatticeRunService.cleanupInactiveRun(enabled.scopeID, enabled.id)

      expect(cleaned?.effect).toBeUndefined()
      expect((await BlueprintLoopStore.get(enabled.scopeID, orphan.id)).status).toBe("cancelled")
    })
  })

  test("a real orphan cancellation failure preserves the durable create breadcrumb", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const enabled = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const { effect } = await armCreateEffect(enabled.id)
      await BlueprintLoopStore.create({
        noteID: effect.blueprintNoteID,
        noteVersion: effect.blueprintVersion,
        title: "Retryable orphan",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: effect.sourceDigest,
      })
      await LatticeStore.updateByRunID(enabled.scopeID, enabled.id, (draft) => LatticeMachine.cancel(draft))
      const updateStatus = BlueprintLoopStore.updateStatus
      ;(BlueprintLoopStore.updateStatus as typeof updateStatus) = async () => {
        throw new Error("storage unavailable")
      }
      try {
        await expect(LatticeRunService.cleanupInactiveRun(enabled.scopeID, enabled.id)).rejects.toThrow(
          "storage unavailable",
        )
      } finally {
        ;(BlueprintLoopStore.updateStatus as typeof updateStatus) = updateStatus
      }

      expect((await LatticeStore.getByRunID(enabled.scopeID, enabled.id))?.effect?.kind).toBe("create_blueprint_loop")
    })
  })

  test("cancel terminates every recorded owned Loop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const first = await BlueprintLoopStore.create({
        noteID: "note_cancel_first",
        title: "First cancel owned",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "cancel-first",
      })
      const second = await BlueprintLoopStore.create({
        noteID: "note_cancel_second",
        title: "Second cancel owned",
        sessionID: session.id,
        source: "lattice",
        sourceDigest: "cancel-second",
      })
      await BlueprintLoopStore.updateStatus(run.scopeID, first.id, { status: "running" })
      await BlueprintLoopStore.updateStatus(run.scopeID, second.id, { status: "running" })
      const stepID = Identifier.ascending("lattice_step")
      await LatticeStore.updateByRunID(run.scopeID, run.id, (draft) => {
        const now = Date.now()
        draft.state = "executing"
        draft.currentStepID = stepID
        draft.pathway = [
          LatticeTypes.Step.parse({
            id: stepID,
            title: "Cancel all",
            objective: "Cancel every owned attempt",
            status: "executing",
            acceptanceCriteria: [],
            assumptions: [],
            blueprintHistory: [],
            loopHistory: [
              { loopID: first.id, status: "running", sourceDigest: "cancel-first", time: { created: now } },
              { loopID: second.id, status: "running", sourceDigest: "cancel-second", time: { created: now } },
            ],
            time: { created: now, updated: now, started: now },
          }),
        ]
      })

      await LatticeRunService.cancel(run.id)

      expect((await BlueprintLoopStore.get(run.scopeID, first.id)).status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(run.scopeID, second.id)).status).toBe("cancelled")
    })
  })

  test("retrying cancel finishes an owned Loop left running after terminal persistence", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const loop = await attachRunningLoop(run.id, session.id)
      await LatticeStore.updateByRunID(ScopeContext.current.scope.id, run.id, (draft) => LatticeMachine.cancel(draft))

      const cancelled = await LatticeRunService.cancel(run.id)

      expect(cancelled.status).toBe("cancelled")
      expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")
    })
  })

  test("enable rejects an active foreign BlueprintLoop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const loop = await BlueprintLoopStore.create({ noteID: "note_x", title: "T", sessionID: session.id })
      await Session.update(session.id, (draft) => {
        draft.blueprint = { loopID: loop.id }
      })

      await expect(LatticeRunService.enable({ sessionID: session.id, mode: "auto" })).rejects.toMatchObject({
        data: { reason: expect.stringContaining("active BlueprintLoop") },
      })
      expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("armed")
    })
  })
})
