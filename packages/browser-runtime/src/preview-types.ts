import { z } from "zod"

export const BrowserPreviewUnavailableSchema = z.enum([
  "invalid_url",
  "blocked_address",
  "dns_failed",
  "network_error",
  "timeout",
  "cancelled",
  "redirect_loop",
  "redirect_limit",
  "target_changed",
  "authentication_required",
  "bot_challenge",
  "http_error",
  "non_text",
  "unsupported_encoding",
  "too_large",
  "empty_metadata",
  "invalid_range",
])

export const BrowserPreviewInputSchema = z.object({ url: z.string().min(1).max(20_000) }).strict()

export const BrowserPreviewResultSchema = z
  .object({
    title: z.string(),
    source: z.string(),
    path: z.string().optional(),
    description: z.string().optional(),
    code: z
      .object({ text: z.string(), language: z.string().optional(), startLine: z.number().int().positive().optional() })
      .strict()
      .optional(),
    meta: z.string().optional(),
    unavailable: BrowserPreviewUnavailableSchema.optional(),
  })
  .strict()
  .meta({ ref: "BrowserPreviewResult" })

export type BrowserPreviewResult = z.infer<typeof BrowserPreviewResultSchema>
export type BrowserPreviewUnavailable = z.infer<typeof BrowserPreviewUnavailableSchema>

export class BrowserPreviewFailure extends Error {
  constructor(readonly reason: BrowserPreviewUnavailable) {
    super(reason)
    this.name = "BrowserPreviewFailure"
  }
}
