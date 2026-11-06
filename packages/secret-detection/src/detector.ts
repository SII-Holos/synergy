import { z } from "zod"

export namespace SecretDetection {
  export const Source = z.enum(["user_message", "tool_output", "credential_file"])
  export type Source = z.infer<typeof Source>
  export const Finding = z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    kind: z.string().min(1),
    score: z.number().min(0).max(1).optional(),
  })
  export type Finding = z.infer<typeof Finding>
  export const Result = z.discriminatedUnion("complete", [
    z.object({ complete: z.literal(true), findings: z.array(Finding) }),
    z.object({
      complete: z.literal(false),
      findings: z.array(Finding),
      reason: z.enum(["input_limit", "unsupported"]),
    }),
  ])
  export type Result = z.infer<typeof Result>
  export interface Input {
    text: string
    source: Source
    signal?: AbortSignal
  }
  export interface Detector {
    readonly id: string
    readonly version: string
    detect(input: Input): Promise<Result>
  }
  export class Error extends globalThis.Error {
    constructor(readonly code: "aborted" | "timeout" | "invalid_result" | "detector_failed" | "incomplete") {
      super(`Secret detection failed: ${code}`)
      this.name = "SecretDetectionError"
    }
  }

  function splitsSurrogate(text: string, offset: number) {
    const left = text.charCodeAt(offset - 1)
    const right = text.charCodeAt(offset)
    return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
  }

  export function validate(text: string, result: unknown): Result {
    const parsed = Result.safeParse(result)
    if (!parsed.success) throw new Error("invalid_result")
    let end = 0
    for (const finding of parsed.data.findings) {
      if (
        finding.start < end ||
        finding.end <= finding.start ||
        finding.end > text.length ||
        splitsSurrogate(text, finding.start) ||
        splitsSurrogate(text, finding.end)
      )
        throw new Error("invalid_result")
      end = finding.end
    }
    return parsed.data
  }

  export async function detect(
    detector: Detector,
    input: Input,
    options: { timeoutMs?: number } = {},
  ): Promise<Result> {
    if (input.signal?.aborted) throw new Error("aborted")
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError("timeoutMs must be a positive finite number")
    }
    const controller = new AbortController()
    let rejectAbort!: (error: Error) => void
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const cancel = (code: "aborted" | "timeout") => {
      rejectAbort(new Error(code))
      controller.abort()
    }
    const onAbort = () => cancel("aborted")
    input.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => cancel("timeout"), options.timeoutMs)
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          detector.detect({ text: input.text, source: input.source, signal: controller.signal }),
        ),
        cancelled,
      ])
      if (input.signal?.aborted) throw new Error("aborted")
      return validate(input.text, result)
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error("detector_failed")
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
  }
}
