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
      const issue = parsed.error.issues[0]
      context.addIssue({
        code: "custom",
        path: issue?.path ?? ["action"],
        message: issue?.message ?? `Invalid fields for ${value.action}`,
      })
    })

  export function parseToolInput(input: unknown): Input {
    return Input.parse(ToolInput.parse(input))
  }
}
