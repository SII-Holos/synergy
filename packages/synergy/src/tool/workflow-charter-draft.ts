import z from "zod"
import { Tool } from "./tool"
import { CharterValidate, CharterStore, WorkflowTypes } from "../workflow-run"
import DESCRIPTION from "./workflow-charter-draft.txt"

const SeatInput = z.object({
  name: z.string(),
  agent: z.string(),
  charterPrompt: z.string().optional(),
  charterNoteID: z.string().optional(),
  controlProfile: z.enum(["guarded", "autonomous", "full_access"]).optional(),
  interaction: z.enum(["unattended", "interactive"]).optional(),
  pool: z.number().int().min(1).optional(),
  worktree: z.enum(["none", "per_entity", "shared"]).optional(),
})

const TransitionInput = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  trigger: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("event") }),
    z.object({ kind: z.literal("intent"), allowedSeats: z.array(z.string()) }),
    z.object({ kind: z.literal("gate"), gate: z.string() }),
  ]),
  guards: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.string()).optional() })).optional(),
  effects: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })).optional(),
  blockOnGuardFail: z.boolean().optional(),
})

const parameters = z.object({
  name: z.string(),
  entityType: z.string(),
  entityInitialState: z.string(),
  states: z.array(z.string()),
  terminalStates: z.array(z.string()).optional(),
  seats: z.array(SeatInput),
  transitions: z.array(TransitionInput),
  gates: z
    .array(
      z.object({
        name: z.string(),
        title: z.string(),
        description: z.string().optional(),
        resolutions: z.array(z.string()),
      }),
    )
    .optional(),
  budget: z.object({ maxModelCalls: z.number() }).optional(),
  persist: z.boolean().optional().describe("Persist as a new charter version when the draft is valid."),
  charterID: z.string().optional().describe("When persisting, bump this existing charter to a new version."),
})

export const WorkflowCharterDraftTool = Tool.define("workflow_charter_draft", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const draft: CharterValidate.Draft = {
      name: params.name,
      entityType: params.entityType,
      entityInitialState: params.entityInitialState,
      states: params.states,
      terminalStates: params.terminalStates,
      seats: params.seats.map((s) => WorkflowTypes.SeatDef.parse(s)),
      transitions: params.transitions.map((t) => WorkflowTypes.TransitionDef.parse(t)),
      gates: params.gates,
      budget: params.budget,
    }

    const result = CharterValidate.validate(draft)
    // Persist the auto-fixed draft (e.g. with the reserved 'blocked' state added).
    const normalized = result.normalized
    const lines = [`Charter "${normalized.name}" validation: ${result.valid ? "VALID" : "INVALID"}`]
    if (result.fixes.length) lines.push("", "Auto-fixes applied:", ...result.fixes.map((f) => `  - ${f}`))
    if (result.errors.length)
      lines.push("", "Errors (must fix before persisting):", ...result.errors.map((e) => `  - ${e}`))
    if (result.warnings.length) lines.push("", "Warnings:", ...result.warnings.map((w) => `  - ${w}`))

    if (!result.valid) {
      lines.push(
        "",
        "Reference — a working charter dispatches entities automatically:",
        "  • The first transition out of the initial state must be trigger:{kind:'event'} with effects [assign_entity, send_handoff].",
        "  • 'event' transitions fire automatically when their guards pass; 'intent' transitions are submitted by a seat via workflow_submit; 'gate' transitions fire when the Boss resolves a gate.",
        `  • Available guard predicates: ${CharterValidate.availableGuards().join(", ")}`,
        `  • Available effects: ${CharterValidate.availableEffects().join(", ")}`,
        "  • For a common code flow you can skip authoring entirely: workflow_run_create with no charterID uses the built-in Issue → PR → Test charter.",
      )
    }

    let charterRef: { id: string; version: number } | undefined
    if (params.persist && result.valid) {
      const charter = await CharterStore.create({
        id: params.charterID,
        name: normalized.name,
        description: normalized.description,
        entityType: normalized.entityType,
        entityInitialState: normalized.entityInitialState,
        states: normalized.states,
        terminalStates: normalized.terminalStates,
        seats: normalized.seats,
        transitions: normalized.transitions,
        gates: normalized.gates,
        budget: normalized.budget,
      })
      charterRef = { id: charter.id, version: charter.version }
      lines.push(
        "",
        `Persisted as charter ${charter.id} v${charter.version}. Instantiate it with workflow_run_create({ charterID: "${charter.id}" }).`,
      )
    } else if (params.persist && !result.valid) {
      lines.push("", "Not persisted — fix the errors above and call workflow_charter_draft again.")
    }

    return {
      title: result.valid ? "Charter valid" : "Charter needs fixes",
      output: lines.join("\n"),
      metadata: {
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        fixes: result.fixes,
        charterRef,
        availableGuards: CharterValidate.availableGuards(),
        availableEffects: CharterValidate.availableEffects(),
      } as Record<string, any>,
    }
  },
})
