import { WorkflowEffects } from "./effects"
import { WorkflowGuards } from "./guards"
import { WorkflowTypes } from "./types"

/**
 * Layered charter validation, mirroring Dag.validate's structure: hard errors
 * (unknown predicate/effect, unreachable states, dangling references),
 * auto-fixes, and semantic warnings (external-write effects without a gate,
 * missing budget, states with no exit). A draft is only instantiable when
 * `valid` is true.
 */
export namespace CharterValidate {
  export interface Draft {
    name: string
    entityType: string
    entityInitialState: string
    states: string[]
    terminalStates?: string[]
    seats: WorkflowTypes.SeatDef[]
    transitions: WorkflowTypes.TransitionDef[]
    gates?: WorkflowTypes.GateDef[]
    budget?: { maxModelCalls: number }
  }

  export interface Result {
    valid: boolean
    errors: string[]
    warnings: string[]
    fixes: string[]
  }

  const EXTERNAL_WRITE_EFFECTS = new Set(["start_blueprint_loop"])

  export function validate(draft: Draft): Result {
    const errors: string[] = []
    const warnings: string[] = []
    const fixes: string[] = []

    const states = new Set(draft.states)
    const seatNames = new Set(draft.seats.map((s) => s.name))

    // --- Layer 1: hard structural errors ---
    if (!states.has(WorkflowTypes.BLOCKED_STATE)) {
      errors.push(`states must include the reserved '${WorkflowTypes.BLOCKED_STATE}' state`)
    }
    if (!states.has(draft.entityInitialState)) {
      errors.push(`entityInitialState '${draft.entityInitialState}' is not in states`)
    }
    for (const terminal of draft.terminalStates ?? []) {
      if (!states.has(terminal)) errors.push(`terminal state '${terminal}' is not in states`)
    }
    if (draft.seats.length === 0) errors.push("charter needs at least one seat")

    const transitionIDs = new Set<string>()
    for (const t of draft.transitions) {
      if (transitionIDs.has(t.id)) fixes.push(`duplicate transition id '${t.id}' (later definition wins)`)
      transitionIDs.add(t.id)
      if (!states.has(t.from)) errors.push(`transition '${t.id}' from-state '${t.from}' is not in states`)
      if (!states.has(t.to)) errors.push(`transition '${t.id}' to-state '${t.to}' is not in states`)
      if (t.trigger.kind === "intent") {
        for (const seat of t.trigger.allowedSeats) {
          if (!seatNames.has(seat)) errors.push(`transition '${t.id}' allows unknown seat '${seat}'`)
        }
      }
      if (t.trigger.kind === "gate") {
        const gateName = t.trigger.gate
        const gate = (draft.gates ?? []).find((g) => g.name === gateName)
        if (!gate) errors.push(`transition '${t.id}' references undefined gate '${gateName}'`)
      }
      for (const guard of t.guards) {
        if (!WorkflowGuards.has(guard.name)) errors.push(`transition '${t.id}' uses unknown predicate '${guard.name}'`)
      }
      for (const effect of t.effects) {
        if (!WorkflowEffects.has(effect.name)) errors.push(`transition '${t.id}' uses unknown effect '${effect.name}'`)
      }
    }

    // --- Layer 1b: reachability ---
    if (states.has(draft.entityInitialState)) {
      const reachable = computeReachable(draft)
      for (const state of draft.states) {
        if (state === WorkflowTypes.BLOCKED_STATE) continue
        if (!reachable.has(state)) warnings.push(`state '${state}' is unreachable from the initial state`)
      }
    }

    // --- Layer 3: semantic warnings ---
    const terminalSet = new Set(draft.terminalStates ?? [])
    for (const state of draft.states) {
      if (state === WorkflowTypes.BLOCKED_STATE || terminalSet.has(state)) continue
      const hasExit = draft.transitions.some((t) => t.from === state)
      if (!hasExit) warnings.push(`state '${state}' has no outgoing transition — verify this is intentional`)
    }
    for (const seat of draft.seats) {
      if (!seat.charterPrompt?.trim() && !seat.charterNoteID) {
        warnings.push(`seat '${seat.name}' has no charter prompt or note`)
      }
    }
    if (!draft.budget || draft.budget.maxModelCalls === 0) {
      warnings.push("no model-call budget set — the run can consume unbounded model calls")
    }
    for (const t of draft.transitions) {
      const writesExternally = t.effects.some((e) => EXTERNAL_WRITE_EFFECTS.has(e.name))
      const guarded = t.trigger.kind === "gate" || (draft.gates ?? []).length > 0
      if (writesExternally && !guarded) {
        warnings.push(`transition '${t.id}' triggers external-write work with no gate in the charter`)
      }
    }

    return { valid: errors.length === 0, errors, warnings, fixes }
  }

  function computeReachable(draft: Draft): Set<string> {
    const adjacency = new Map<string, string[]>()
    for (const t of draft.transitions) {
      const list = adjacency.get(t.from) ?? []
      list.push(t.to)
      adjacency.set(t.from, list)
    }
    const seen = new Set<string>([draft.entityInitialState])
    const stack = [draft.entityInitialState]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    return seen
  }
}
