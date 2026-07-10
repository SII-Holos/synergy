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
    const lines = [`Charter "${draft.name}" validation: ${result.valid ? "VALID" : "INVALID"}`]
    if (result.errors.length) lines.push("", "Errors:", ...result.errors.map((e) => `  - ${e}`))
    if (result.warnings.length) lines.push("", "Warnings:", ...result.warnings.map((w) => `  - ${w}`))
    if (result.fixes.length) lines.push("", "Auto-fixes:", ...result.fixes.map((f) => `  - ${f}`))

    let charterRef: { id: string; version: number } | undefined
    if (params.persist) {
      if (!result.valid) throw new Error("Cannot persist an invalid charter. Fix the errors above first.")
      const charter = await CharterStore.create({
        id: params.charterID,
        name: draft.name,
        entityType: draft.entityType,
        entityInitialState: draft.entityInitialState,
        states: draft.states,
        terminalStates: draft.terminalStates,
        seats: draft.seats,
        transitions: draft.transitions,
        gates: draft.gates,
        budget: draft.budget,
      })
      charterRef = { id: charter.id, version: charter.version }
      lines.push("", `Persisted as charter ${charter.id} v${charter.version}.`)
    }

    return {
      title: result.valid ? "Charter valid" : "Charter invalid",
      output: lines.join("\n"),
      metadata: { valid: result.valid, errors: result.errors, warnings: result.warnings, charterRef } as Record<
        string,
        any
      >,
    }
  },
})
