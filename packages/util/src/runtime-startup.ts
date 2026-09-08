import { z } from "zod"

export const RUNTIME_STARTUP_PREFIX = "SYNERGY_STARTUP_V1 "
export const RUNTIME_STARTUP_MAX_LINE_LENGTH = 1024

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const RuntimeStartupProgress = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("starting") }).strict(),
  z
    .object({
      phase: z.literal("migration"),
      step: count.positive(),
      current: count,
      total: count,
    })
    .strict()
    .refine((value) => value.current <= value.total),
])
export type RuntimeStartupProgress = z.infer<typeof RuntimeStartupProgress>

export function runtimeStartupLine(progress: RuntimeStartupProgress): string {
  return RUNTIME_STARTUP_PREFIX + JSON.stringify(RuntimeStartupProgress.parse(progress)) + "\n"
}
