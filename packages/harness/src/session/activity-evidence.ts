import { z } from "zod"
import { RolloutSchema } from "./rollout/schema"

export const ToolActivityEvidence = z
  .object({
    kind: z.enum(["file-read", "file-change", "command", "search", "object", "media", "structured"]),
    resource: z
      .object({
        path: z.string().optional(),
        workspaceID: z.string().optional(),
        generation: z.number().optional(),
        objectID: z.string().optional(),
      })
      .optional(),
    range: z
      .object({
        startLine: z.number().int().nonnegative(),
        lineCount: z.number().int().nonnegative(),
        totalLines: z.number().int().nonnegative().optional(),
      })
      .optional(),
    ranges: z
      .array(z.object({ startLine: z.number().int().nonnegative(), lineCount: z.number().int().nonnegative() }))
      .optional(),
    content: RolloutSchema.ArtifactRef.optional(),
    mediaType: z.string().optional(),
    truncated: z.boolean().optional(),
    processID: z.string().optional(),
    directory: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
    background: z.boolean().optional(),
  })
  .strict()
  .meta({ ref: "ToolActivityEvidence" })
export type ToolActivityEvidence = z.infer<typeof ToolActivityEvidence>
export type ToolActivityCapture = Omit<ToolActivityEvidence, "content"> & { text: string }
