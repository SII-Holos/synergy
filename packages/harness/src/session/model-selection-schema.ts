import { z } from "zod"

export namespace ModelSelection {
  export const Model = z.object({ providerID: z.string(), modelID: z.string() })
  export type Model = z.infer<typeof Model>
  export const Thinking = z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("provider-default") }),
      z.object({ mode: z.literal("off") }),
      z.object({ mode: z.literal("variant"), variant: z.string().min(1) }),
    ])
    .meta({ ref: "SessionThinkingSelection" })
  export type Thinking = z.infer<typeof Thinking>
  export const Selection = z.object({ model: Model, thinking: Thinking }).meta({ ref: "SessionModelChoice" })
  export type Selection = z.infer<typeof Selection>
  export const Request = Selection.extend({
    revision: z.number().int().nonnegative(),
    rootID: z.string(),
  }).meta({ ref: "SessionRequestModelSelection" })
  export type Request = z.infer<typeof Request>
  export const State = z
    .object({
      revision: z.number().int().nonnegative(),
      selected: Selection,
      preferences: z.record(z.string(), Thinking),
      lastUsed: Request.extend({ messageID: z.string() }).optional(),
      pendingReason: z.enum(["next-request", "tool-turn"]).optional(),
    })
    .meta({ ref: "SessionModelSelection" })
  export type State = z.infer<typeof State>
  export const Input = z
    .object({
      model: Model,
      thinking: Thinking.optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
    })
    .meta({ ref: "SessionModelSelectionInput" })
  export type Input = z.infer<typeof Input>

  export function key(model: Model) {
    return JSON.stringify([model.providerID, model.modelID])
  }

  export function fromVariant(variant?: string): Thinking {
    if (variant === "off") return { mode: "off" }
    return variant ? { mode: "variant", variant } : { mode: "provider-default" }
  }

  export function legacy(
    override: Model | undefined,
    roots: Array<{ model: Model; variant?: string; thinking?: Thinking }>,
  ): State | undefined {
    const model = override ?? roots.at(-1)?.model
    if (!model) return
    const preferences = Object.fromEntries(
      roots.map((root) => [key(root.model), root.thinking ?? fromVariant(root.variant)]),
    )
    const thinking = preferences[key(model)] ?? { mode: "provider-default" }
    return { revision: 0, selected: { model, thinking }, preferences: { ...preferences, [key(model)]: thinking } }
  }
}
