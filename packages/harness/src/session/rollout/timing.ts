import { z } from "zod"

export namespace RolloutTiming {
  const Duration = z.number().finite().nonnegative()
  export const Info = z
    .object({
      source: z.literal("transport"),
      sentAt: z.number().optional(),
      headersAt: z.number().optional(),
      firstByteAt: z.number().optional(),
      firstContentAt: z.number().optional(),
      lastContentAt: z.number().optional(),
      endedAt: z.number().optional(),
      detectedAt: z.number().optional(),
      headersMs: Duration.optional(),
      firstByteMs: Duration.optional(),
      ttftMs: Duration.optional(),
      generationMs: Duration.optional(),
      requestMs: Duration.optional(),
      contentEvents: z.number().int().nonnegative(),
      reasoningObserved: z.boolean(),
      streaming: z.boolean(),
      backpressured: z.boolean().optional(),
    })
    .strict()
  export type Info = z.infer<typeof Info>
  export const Rate = z
    .object({
      value: Duration.nullable(),
      tokens: Duration,
      milliseconds: Duration,
      samples: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
      reasons: z.record(z.string(), z.number().int().nonnegative()).default({}),
    })
    .strict()
  export type Rate = z.infer<typeof Rate>

  export function merge(rates: Iterable<Rate>): Rate {
    const result: Rate = { value: null, tokens: 0, milliseconds: 0, samples: 0, excluded: 0, reasons: {} }
    for (const rate of rates) {
      result.tokens += rate.tokens
      result.milliseconds += rate.milliseconds
      result.samples += rate.samples
      result.excluded += rate.excluded
      for (const [reason, count] of Object.entries(rate.reasons))
        result.reasons[reason] = (result.reasons[reason] ?? 0) + count
    }
    result.value = result.milliseconds > 0 ? (result.tokens * 1000) / result.milliseconds : null
    return result
  }

  export function rates(
    timing: Info | undefined,
    output: { total: number | null; reasoning: number | null } | undefined,
  ) {
    function rate(milliseconds: number | undefined, reason?: string): Rate {
      reason ??=
        output?.total == null
          ? "output_usage_unknown"
          : milliseconds === undefined
            ? "duration_unknown"
            : milliseconds <= 0
              ? "zero_duration"
              : undefined
      if (reason) return { value: null, tokens: 0, milliseconds: 0, samples: 0, excluded: 1, reasons: { [reason]: 1 } }
      return {
        value: (output!.total! * 1000) / milliseconds!,
        tokens: output!.total!,
        milliseconds: milliseconds!,
        samples: 1,
        excluded: 0,
        reasons: {},
      }
    }
    return {
      generation: rate(
        timing?.generationMs,
        !timing
          ? "timing_unknown"
          : timing.backpressured
            ? "capture_backpressure"
            : !timing.streaming
              ? "non_streaming"
              : timing.contentEvents < 2
                ? "insufficient_content"
                : output?.reasoning !== 0 && (!timing.reasoningObserved || output?.reasoning == null)
                  ? "reasoning_coverage_unknown"
                  : undefined,
      ),
      endToEnd: rate(timing?.requestMs),
    }
  }

  export function create() {
    const value: Info = { source: "transport", contentEvents: 0, reasoningObserved: false, streaming: false }
    let sent: number | undefined
    let first: number | undefined
    return {
      sent() {
        sent = performance.now()
        value.sentAt = Date.now()
      },
      backpressure() {
        value.backpressured = true
      },
      headers(streaming: boolean) {
        value.headersAt = Date.now()
        value.headersMs = sent === undefined ? undefined : performance.now() - sent
        value.streaming = streaming
      },
      streaming(streaming: boolean) {
        value.streaming = streaming
      },
      bytes() {
        if (value.firstByteAt !== undefined) return
        value.firstByteAt = Date.now()
        value.firstByteMs = sent === undefined ? undefined : performance.now() - sent
      },
      content(reasoning: boolean) {
        const now = performance.now()
        if (first === undefined) {
          first = now
          value.firstContentAt = Date.now()
          value.ttftMs = sent === undefined ? undefined : now - sent
        }
        value.contentEvents++
        value.reasoningObserved ||= reasoning
        value.lastContentAt = Date.now()
        value.generationMs = now - first
      },
      end() {
        if (value.endedAt !== undefined || sent === undefined) return
        value.endedAt = Date.now()
        value.requestMs = performance.now() - sent
      },
      snapshot(): Info {
        return { ...value }
      },
    }
  }
}
