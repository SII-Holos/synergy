import z from "zod"

export namespace LatticeAction {
  const RequiredString = z.string().trim().min(1)
  const OptionalStringList = z.array(RequiredString).optional()

  export const Input = z
    .discriminatedUnion("action", [
      z
        .object({
          action: z.literal("submit_requirements"),
          goal: RequiredString,
          successCriteria: z.array(RequiredString).min(1),
          constraints: OptionalStringList,
          nonGoals: OptionalStringList,
          assumptions: OptionalStringList,
        })
        .strict(),
      z.object({ action: z.literal("submit_pathway"), reason: RequiredString }).strict(),
      z.object({ action: z.literal("submit_pathway_review"), reason: RequiredString }).strict(),
      z.object({ action: z.literal("submit_blueprint"), blueprintID: RequiredString }).strict(),
      z.object({ action: z.literal("submit_blueprint_review"), reason: RequiredString }).strict(),
      z.object({ action: z.literal("approve_execution"), reason: RequiredString }).strict(),
    ])
    .meta({ ref: "LatticeSubmitInput" })
  export type Input = z.infer<typeof Input>

  export const ToolInput = z
    .object({
      action: z.enum([
        "submit_requirements",
        "submit_pathway",
        "submit_pathway_review",
        "submit_blueprint",
        "submit_blueprint_review",
        "approve_execution",
      ]),
      goal: RequiredString.optional(),
      successCriteria: z.array(RequiredString).min(1).optional(),
      constraints: OptionalStringList,
      nonGoals: OptionalStringList,
      assumptions: OptionalStringList,
      reason: RequiredString.optional(),
      blueprintID: RequiredString.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const parsed = Input.safeParse(value)
      if (parsed.success) return
      const contract = ACTION_CONTRACT[value.action]
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: `Action "${value.action}" accepts exactly ${contract.fields.join(", ")}. ${issues}. Example: ${JSON.stringify(contract.example)}`,
      })
    })

  export function parseToolInput(input: unknown): Input {
    return Input.parse(ToolInput.parse(input))
  }

  const ACTION_CONTRACT: Record<
    Input["action"],
    {
      fields: string[]
      example: Record<string, unknown>
    }
  > = {
    submit_requirements: {
      fields: ["action", "goal", "successCriteria", "constraints?", "nonGoals?", "assumptions?"],
      example: {
        action: "submit_requirements",
        goal: "Deliver the requested outcome",
        successCriteria: ["The observable result is verified"],
      },
    },
    submit_pathway: {
      fields: ["action", "reason"],
      example: { action: "submit_pathway", reason: "The candidate Pathway covers all aligned requirements." },
    },
    submit_pathway_review: {
      fields: ["action", "reason"],
      example: {
        action: "submit_pathway_review",
        reason: "The pending Pathway is correctly scoped, ordered, and verifiable.",
      },
    },
    submit_blueprint: {
      fields: ["action", "blueprintID"],
      example: { action: "submit_blueprint", blueprintID: "note_..." },
    },
    submit_blueprint_review: {
      fields: ["action", "reason"],
      example: {
        action: "submit_blueprint_review",
        reason: "The bound Blueprint is decision-complete and safe to execute.",
      },
    },
    approve_execution: {
      fields: ["action", "reason"],
      example: { action: "approve_execution", reason: "The user explicitly approved this reviewed Blueprint." },
    },
  }

  export function inputContractSummary(): string {
    return Object.entries(ACTION_CONTRACT)
      .map(
        ([action, contract]) =>
          `- ${action}: ${contract.fields.join(", ")}; example ${JSON.stringify(contract.example)}`,
      )
      .join("\n")
  }
}
