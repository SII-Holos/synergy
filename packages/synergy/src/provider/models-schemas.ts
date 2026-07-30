import z from "zod"

export namespace ModelsDev {
  export const ReasoningOption = z.object({
    type: z.string(),
    values: z.array(z.unknown()).optional(),
  })
  export type ReasoningOption = z.infer<typeof ReasoningOption>

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    reasoning_options: z.array(ReasoningOption).optional(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    supported_image_media_types: z.array(z.string()).optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    catalog_state: z.enum(["active", "retained"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export function reasoningEfforts(model: { reasoning_options?: ReasoningOption[] }) {
    if (!Array.isArray(model.reasoning_options)) return
    const values = model.reasoning_options.find((option) => option?.type === "effort")?.values
    if (!Array.isArray(values)) return
    const efforts = values.filter((value): value is string => typeof value === "string")
    return efforts.length > 0 ? efforts : undefined
  }

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    signupUrl: z.string().optional(),
    recommendation: z
      .object({
        level: z.enum(["featured", "recommended", "standard"]),
        rank: z.number().int().optional(),
        headline: z.string().optional(),
        reason: z.string().optional(),
        cta: z
          .object({
            kind: z.literal("external"),
            label: z.string(),
            url: z.string(),
          })
          .strict()
          .optional(),
        defaultModel: z.string().optional(),
      })
      .strict()
      .optional(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>
}
