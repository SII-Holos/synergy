import { WorkflowEffects } from "./effects"
import { WorkflowGuards } from "./guards"
import { WorkflowTypes } from "./types"

/**
 * Layered charter validation, mirroring Dag.validate's forgiving structure:
 * auto-fixes for mechanical omissions (missing `blocked` state), hard errors for
 * things that make a run impossible or dead-on-arrival (unknown predicate/effect,
 * dangling references, and — critically — a machine that never dispatches work to
 * a seat), and warnings for the merely suspicious. `validate` returns a
 * normalized draft with the auto-fixes applied so callers persist the corrected
 * charter, not the raw input.
 */
export namespace CharterValidate {
  export interface Draft {
    name: string
    description?: string
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
    /** The draft with auto-fixes applied; persist this, not the raw input. */
    normalized: Draft
  }

  /** Effects that move an entity onto a seat — a charter needs at least one. */
  const DISPATCH_EFFECTS = new Set(["assign_entity", "send_handoff"])
  const EXTERNAL_WRITE_EFFECTS = new Set(["start_blueprint_loop"])

  export function availableGuards(): string[] {
    return WorkflowGuards.names().sort()
  }

  export function availableEffects(): string[] {
    return WorkflowEffects.names().sort()
  }

  export function validate(input: Draft): Result {
    const errors: string[] = []
    const warnings: string[] = []
    const fixes: string[] = []

    // Work on a shallow copy so auto-fixes don't mutate the caller's input.
    const draft: Draft = { ...input, states: [...input.states], terminalStates: [...(input.terminalStates ?? [])] }

    // --- Layer 0: auto-fixes (be forgiving about mechanical omissions) ---
    if (!draft.states.includes(WorkflowTypes.BLOCKED_STATE)) {
      draft.states.push(WorkflowTypes.BLOCKED_STATE)
      fixes.push(
        `added the reserved '${WorkflowTypes.BLOCKED_STATE}' state (required; the engine parks failed entities there)`,
      )
    }

    const states = new Set(draft.states)
    const seatNames = new Set<string>()
    for (const seat of draft.seats) {
      if (seatNames.has(seat.name)) errors.push(`duplicate seat name '${seat.name}'`)
      seatNames.add(seat.name)
    }
    const gateNames = new Set<string>()
    for (const gate of draft.gates ?? []) {
      if (gateNames.has(gate.name)) errors.push(`duplicate gate name '${gate.name}'`)
      gateNames.add(gate.name)
    }

    // --- Layer 1: hard structural errors ---
    if (!states.has(draft.entityInitialState)) {
      errors.push(`entityInitialState '${draft.entityInitialState}' is not in states`)
    }
    for (const terminal of draft.terminalStates ?? []) {
      if (!states.has(terminal)) errors.push(`terminal state '${terminal}' is not in states`)
    }
    if (draft.seats.length === 0) errors.push("charter needs at least one seat")

    const transitionIDs = new Set<string>()
    for (const t of draft.transitions) {
      if (transitionIDs.has(t.id)) errors.push(`duplicate transition id '${t.id}'`)
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
        if (!WorkflowGuards.has(guard.name)) {
          errors.push(
            `transition '${t.id}' uses unknown predicate '${guard.name}'. Available: ${availableGuards().join(", ")}`,
          )
        }
      }
      for (const effect of t.effects) {
        if (!WorkflowEffects.has(effect.name)) {
          errors.push(
            `transition '${t.id}' uses unknown effect '${effect.name}'. Available: ${availableEffects().join(", ")}`,
          )
        }
      }
    }

    // --- Layer 2: the "valid but dead" traps (the #1 authoring footgun) ---
    // Entities enter the initial state and can only leave it via an EVENT
    // transition (no seat is assigned yet, so an intent-only initial state can
    // never fire). Without this, every enqueued entity sits in the backlog
    // forever — a run that looks live but does nothing.
    const initialEventTransitions = draft.transitions.filter(
      (t) => t.from === draft.entityInitialState && t.trigger.kind === "event",
    )
    if (draft.transitions.length > 0 && initialEventTransitions.length === 0) {
      errors.push(
        `the initial state '${draft.entityInitialState}' has no outgoing event transition, so enqueued entities can never start. ` +
          `Add an { trigger: { kind: "event" } } transition out of '${draft.entityInitialState}' whose effects include ` +
          `assign_entity (and usually send_handoff) so the engine dispatches new entities to a seat automatically.`,
      )
    }
    const dispatches = draft.transitions.some((t) => t.effects.some((e) => DISPATCH_EFFECTS.has(e.name)))
    if (draft.transitions.length > 0 && !dispatches) {
      errors.push(
        `no transition dispatches work to a seat — add an assign_entity or send_handoff effect somewhere, ` +
          `otherwise seats never receive tasks and entities never progress.`,
      )
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
      if (!seat.charterPrompt?.trim()) warnings.push(`seat '${seat.name}' has no charter prompt`)
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

    return { valid: errors.length === 0, errors, warnings, fixes, normalized: draft }
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
