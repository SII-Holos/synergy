import { Identifier } from "../id/id"
import { NoteDocument, NoteStore } from "../note"
import { LatticeAction } from "./action"
import { LatticeError } from "./error"
import { LatticeMachine } from "./machine"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

export namespace LatticeActionService {
  export type SubmitInput = {
    scopeID: string
    sessionID: string
    source: LatticeTypes.PendingAction["source"]
    input: LatticeAction.Input
  }

  export type SubmitResult = {
    run: LatticeTypes.Run
    disposition: "queued" | "already_queued"
  }

  const EXPECTED_STATE: Record<LatticeAction.Input["action"], LatticeTypes.State> = {
    submit_requirements: "clarifying",
    submit_pathway: "planning",
    submit_pathway_review: "reviewing_pathway",
    submit_blueprint: "blueprinting",
    submit_blueprint_review: "reviewing_blueprint",
    approve_execution: "awaiting_execution",
  }

  export function expectedState(action: LatticeAction.Input["action"]): LatticeTypes.State {
    return EXPECTED_STATE[action]
  }

  export function validAction(state: LatticeTypes.State): LatticeAction.Input["action"] | undefined {
    return (Object.entries(EXPECTED_STATE) as [LatticeAction.Input["action"], LatticeTypes.State][]).find(
      ([, expected]) => expected === state,
    )?.[0]
  }

  /** Persist one semantic intent. State transitions and effects are owned by LatticeController. */
  export async function submit(input: SubmitInput): Promise<LatticeTypes.Run> {
    return (await submitWithResult(input)).run
  }

  /** Persist one semantic intent and report whether this call queued it or matched the existing durable intent. */
  export async function submitWithResult(input: SubmitInput): Promise<SubmitResult> {
    const current = await LatticeStore.getOrUndefined(input.scopeID, input.sessionID)
    if (!current) throw new LatticeError.NotFound({ sessionID: input.sessionID })
    if (current.status !== "active") {
      throw new LatticeError.StateConflict({ state: current.state, reason: `run is ${current.status}` })
    }

    const expected = expectedState(input.input.action)
    if (current.state !== expected) {
      throw new LatticeError.StateConflict({
        state: current.state,
        reason: `${input.input.action} is only valid in ${expected}`,
      })
    }

    const action = await materialize(current, input.source, input.input)
    let submitted = false
    const updated = await LatticeStore.updateByRunID(input.scopeID, current.id, (draft) => {
      if (draft.status !== "active") {
        throw new LatticeError.StateConflict({ state: draft.state, reason: `run is ${draft.status}` })
      }
      if (draft.state !== expected) {
        throw new LatticeError.StateConflict({
          state: draft.state,
          reason: `${input.input.action} is only valid in ${expected}`,
        })
      }
      if (draft.pendingAction) {
        if (sameSemanticAction(draft.pendingAction, action)) return
        throw new LatticeError.StateConflict({
          state: draft.state,
          reason: `action ${draft.pendingAction.id} is already pending`,
        })
      }
      submitted = true
      return LatticeMachine.queueAction(draft, action)
    })
    if (!submitted) return { run: updated, disposition: "already_queued" }
    void LatticeStore.appendEvent(input.scopeID, updated, {
      kind: "action_submitted",
      state: updated.state,
      message: `${action.kind} submitted`,
    }).catch(() => undefined)
    return { run: updated, disposition: "queued" }
  }

  async function materialize(
    run: LatticeTypes.Run,
    source: LatticeTypes.PendingAction["source"],
    input: LatticeAction.Input,
  ): Promise<LatticeTypes.PendingAction> {
    const base = {
      id: Identifier.ascending("lattice_action"),
      source,
      expectedStateRevision: run.stateRevision,
      expectedPathwayRevision: run.pathwayRevision,
      time: { created: Date.now() },
    }

    switch (input.action) {
      case "submit_requirements":
        return {
          ...base,
          kind: input.action,
          requirements: {
            goal: input.goal,
            successCriteria: input.successCriteria,
            constraints: input.constraints ?? [],
            nonGoals: input.nonGoals ?? [],
            assumptions: input.assumptions ?? [],
          },
        }
      case "submit_pathway":
      case "submit_pathway_review":
        return { ...base, kind: input.action, reason: input.reason }
      case "submit_blueprint": {
        const blueprint = await readBlueprint(run.scopeID, input.blueprintID)
        return {
          ...base,
          kind: input.action,
          blueprintID: blueprint.id,
          blueprintVersion: blueprint.version,
          contentDigest: blueprint.digest,
        }
      }
      case "submit_blueprint_review": {
        const step = LatticeMachine.currentStep(run)
        if (!step?.blueprint) {
          throw new LatticeError.StateConflict({ state: run.state, reason: "the current Step has no Blueprint" })
        }
        const blueprint = await readBlueprint(run.scopeID, step.blueprint.noteID)
        return {
          ...base,
          kind: input.action,
          reason: input.reason,
          blueprintVersion: blueprint.version,
          contentDigest: blueprint.digest,
        }
      }
      case "approve_execution": {
        const step = LatticeMachine.currentStep(run)
        const binding = step?.blueprint
        if (!binding) {
          throw new LatticeError.StateConflict({ state: run.state, reason: "the current Step has no Blueprint" })
        }
        const blueprint = await readBlueprint(run.scopeID, binding.noteID)
        if (binding.reviewedVersion !== blueprint.version || binding.reviewedContentDigest !== blueprint.digest) {
          throw new LatticeError.StateConflict({
            state: run.state,
            reason: "The Blueprint changed after review and must be reviewed again before execution.",
          })
        }
        return {
          ...base,
          kind: input.action,
          reason: input.reason,
          blueprintVersion: blueprint.version,
          contentDigest: blueprint.digest,
        }
      }
    }
  }

  async function readBlueprint(
    scopeID: string,
    noteID: string,
  ): Promise<{ id: string; version: number; digest: string }> {
    const note = await NoteStore.getAny(scopeID, noteID).catch(() => undefined)
    if (!note || note.kind !== "blueprint" || note.archived) {
      throw new LatticeError.StateConflict({ state: "blueprinting", reason: `Blueprint ${noteID} is unavailable` })
    }
    return { id: note.id, version: note.version, digest: NoteDocument.hash(note.content) }
  }

  function sameSemanticAction(left: LatticeTypes.PendingAction, right: LatticeTypes.PendingAction): boolean {
    if (left.kind !== right.kind || left.source !== right.source) return false
    const omitEnvelope = (value: LatticeTypes.PendingAction) => {
      const {
        id: _id,
        expectedStateRevision: _state,
        expectedPathwayRevision: _pathway,
        time: _time,
        ...semantic
      } = value
      return semantic
    }
    return JSON.stringify(omitEnvelope(left)) === JSON.stringify(omitEnvelope(right))
  }
}
