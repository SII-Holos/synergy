import z from "zod"
import { Identifier } from "../id/id"

/**
 * WorkflowRun / Boss Mode type system.
 *
 * A Charter is an immutable (per version) definition of a "company": seats,
 * an entity state machine, guards (fixed predicate library), effects (fixed
 * effect library), and human-responsibility gates. A WorkflowRun is one
 * instantiation of a Charter: a scope-level entity that owns persistent seat
 * sessions and entities flowing through the state machine. The run snapshot is
 * the recovery source of truth; the sibling event stream is an audit projection.
 */
export namespace WorkflowTypes {
  // --- Charter (immutable within a version) -------------------------------

  export const WorktreePolicy = z.enum(["none", "per_entity", "shared"])
  export type WorktreePolicy = z.infer<typeof WorktreePolicy>

  export const SeatDef = z
    .object({
      name: z.string().describe("Seat identifier, e.g. 'executor' | 'reviewer' | 'tester'"),
      agent: z.string().describe("Agent name (validated against the agent registry at run creation)"),
      charterPrompt: z.string().optional().describe("Inline standing instructions for this seat"),
      interaction: z.enum(["unattended", "interactive"]).default("unattended"),
      pool: z.number().int().min(1).default(1).describe("Number of parallel instances of this seat"),
      worktree: WorktreePolicy.default("none"),
      model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
    })
    .meta({ ref: "WorkflowSeatDef" })
  export type SeatDef = z.infer<typeof SeatDef>

  /**
   * A guard/effect argument value. Only three forms are permitted:
   *  - a literal string;
   *  - "$entity.bindings.<key>" / "$entity.<field>";
   *  - "$run.<field>".
   * Resolved by a fixed resolver — this is NOT an expression language.
   */
  export const PredicateRef = z
    .object({
      name: z.string().describe("Predicate name (must exist in the guard registry)"),
      args: z.record(z.string(), z.string()).default({}),
    })
    .meta({ ref: "WorkflowPredicateRef" })
  export type PredicateRef = z.infer<typeof PredicateRef>

  export const EffectRef = z
    .object({
      name: z.string().describe("Effect name (must exist in the effect registry)"),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .meta({ ref: "WorkflowEffectRef" })
  export type EffectRef = z.infer<typeof EffectRef>

  export const TransitionTrigger = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("event") }).describe("Engine attempts this transition when a platform fact changes"),
    z.object({
      kind: z.literal("intent"),
      allowedSeats: z.array(z.string()).describe("Seats permitted to submit this transition"),
    }),
    z.object({ kind: z.literal("gate"), gate: z.string() }).describe("Fires after a human resolves the named gate"),
  ])
  export type TransitionTrigger = z.infer<typeof TransitionTrigger>

  export const TransitionDef = z
    .object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      trigger: TransitionTrigger,
      guards: z.array(PredicateRef).default([]),
      effects: z.array(EffectRef).default([]),
      blockOnGuardFail: z
        .boolean()
        .optional()
        .describe(
          "When a guard fails, move the entity to 'blocked' and notify the boss (default true for event triggers)",
        ),
    })
    .meta({ ref: "WorkflowTransitionDef" })
  export type TransitionDef = z.infer<typeof TransitionDef>

  export const GateDef = z
    .object({
      name: z.string(),
      title: z.string(),
      description: z.string().optional(),
      resolutions: z.array(z.string()).min(2).describe("e.g. ['merge','rework','pause','cancel']"),
    })
    .meta({ ref: "WorkflowGateDef" })
  export type GateDef = z.infer<typeof GateDef>

  export const BLOCKED_STATE = "blocked"

  export const Charter = z
    .object({
      id: Identifier.schema("charter"),
      version: z.number().int().min(1),
      name: z.string(),
      description: z.string().optional(),
      entityType: z.string().describe("e.g. 'issue'"),
      entityInitialState: z.string(),
      terminalStates: z.array(z.string()).default([]),
      states: z.array(z.string()).min(2).describe("All states; must include 'blocked'"),
      seats: z.array(SeatDef).min(1),
      transitions: z.array(TransitionDef),
      gates: z.array(GateDef).default([]),
      budget: z.object({ maxModelCalls: z.number().int().min(0).default(0) }).default({ maxModelCalls: 0 }),
      time: z.object({ created: z.number() }),
    })
    .meta({ ref: "WorkflowCharter" })
  export type Charter = z.infer<typeof Charter>

  // --- Run (mutable) ------------------------------------------------------

  export const SeatBinding = z
    .object({
      seat: z.string(),
      instance: z.number().int().min(0),
      sessionID: Identifier.schema("session").optional(),
      entityID: Identifier.schema("workflow_entity").optional(),
      status: z.enum(["unbound", "idle", "working", "waiting"]).default("unbound"),
      lastEntityIDs: z.array(z.string()).default([]).describe("Recently handled entity ids (for affinity)"),
    })
    .meta({ ref: "WorkflowSeatBinding" })
  export type SeatBinding = z.infer<typeof SeatBinding>

  export const Submission = z
    .object({
      id: z.string(),
      kind: z.enum(["review_verdict", "test_report", "deliverable", "note_ref"]),
      seat: z.string(),
      sessionID: z.string(),
      verdict: z.enum(["passed", "changes_requested", "blocked"]).optional(),
      summary: z.string(),
      refs: z.array(z.string()).default([]),
      time: z.number(),
    })
    .meta({ ref: "WorkflowSubmission" })
  export type Submission = z.infer<typeof Submission>

  export const Entity = z
    .object({
      id: Identifier.schema("workflow_entity"),
      runID: Identifier.schema("workflow_run"),
      title: z.string(),
      description: z.string().optional(),
      state: z.string(),
      blockedReason: z.string().optional(),
      bindings: z.record(z.string(), z.string()).default({}),
      submissions: z.array(Submission).default([]),
      assignedSeat: z.object({ seat: z.string(), instance: z.number() }).optional(),
      affinityKey: z.string().optional().describe("Entities sharing this key prefer the same seat instance"),
      pendingHandoffID: z.string().optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        stateEntered: z.number(),
      }),
    })
    .meta({ ref: "WorkflowEntity" })
  export type Entity = z.infer<typeof Entity>

  export const GateInstance = z
    .object({
      id: Identifier.schema("workflow_gate"),
      gate: z.string(),
      entityID: Identifier.schema("workflow_entity").optional(),
      transitionID: z.string(),
      status: z.enum(["pending", "resolved", "expired"]),
      resolution: z.string().optional(),
      resolvedBy: z.enum(["human_ui", "boss_agent"]).optional(),
      context: z.string().optional(),
      time: z.object({ created: z.number(), resolved: z.number().optional() }),
    })
    .meta({ ref: "WorkflowGateInstance" })
  export type GateInstance = z.infer<typeof GateInstance>

  export const PendingEffect = z
    .object({
      id: z.string(),
      transitionEventID: z.string(),
      transitionID: z.string(),
      entityID: Identifier.schema("workflow_entity"),
      effects: z.array(EffectRef),
      nextIndex: z.number().int().min(0).default(0),
    })
    .meta({ ref: "WorkflowPendingEffect" })
  export type PendingEffect = z.infer<typeof PendingEffect>

  export const RunStatus = z.enum(["active", "paused", "completed", "failed", "cancelled"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const Run = z
    .object({
      id: Identifier.schema("workflow_run"),
      scopeID: z.string(),
      charterRef: z.object({ id: Identifier.schema("charter"), version: z.number().int().min(1) }),
      title: z.string(),
      status: RunStatus,
      statusReason: z.string().optional(),
      // Monotonic revision used as a CAS token for concurrent command commits.
      revision: z.number().int().min(0).default(0),
      bossSessionID: Identifier.schema("session"),
      bossControlProfile: z.enum(["guarded", "autonomous", "full_access"]).default("guarded"),
      bossPreviousControlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
      seats: z.array(SeatBinding),
      entities: z.array(Entity),
      gates: z.array(GateInstance),
      pendingEffects: z.array(PendingEffect).default([]),
      effectReceipts: z.record(z.string(), z.number()).optional(),
      budget: z.object({ maxModelCalls: z.number().int().min(0), used: z.number().int().min(0) }),
      time: z.object({ created: z.number(), updated: z.number(), completed: z.number().optional() }),
    })
    .meta({ ref: "WorkflowRun" })
  export type Run = z.infer<typeof Run>

  export const EventKind = z.enum([
    "run_created",
    "run_paused",
    "run_resumed",
    "run_completed",
    "run_failed",
    "run_cancelled",
    "entity_added",
    "entity_transitioned",
    "entity_blocked",
    "guard_failed",
    "effect_executed",
    "effect_failed",
    "seat_session_created",
    "seat_assigned",
    "seat_released",
    "handoff_sent",
    "handoff_acked",
    "submission_recorded",
    "gate_opened",
    "gate_resolved",
    "contractor_spawned",
    "contractor_finished",
    "budget_exhausted",
  ])
  export type EventKind = z.infer<typeof EventKind>

  export const EventInfo = z
    .object({
      id: Identifier.schema("workflow_event"),
      runID: Identifier.schema("workflow_run"),
      scopeID: z.string(),
      kind: EventKind,
      entityID: z.string().optional(),
      seat: z.string().optional(),
      transitionID: z.string().optional(),
      message: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      time: z.object({ created: z.number() }),
    })
    .meta({ ref: "WorkflowEvent" })
  export type EventInfo = z.infer<typeof EventInfo>

  export function isTerminalRun(status: RunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled"
  }

  export function isTerminalState(charter: Charter, state: string): boolean {
    return charter.terminalStates.includes(state)
  }
}
