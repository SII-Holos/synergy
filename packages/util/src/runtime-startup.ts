import { z } from "zod"

export const RUNTIME_STARTUP_PREFIX = "SYNERGY_STARTUP_V1 "
export const RUNTIME_STARTUP_MAX_LINE_LENGTH = 1024

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const StorageStartupProgress = z.object({
  stage: z.enum([
    "prepare",
    "scan",
    "backup",
    "inventory",
    "owners",
    "import",
    "verify",
    "archive-verify",
    "archive-import",
    "validate",
    "activate",
    "check",
    "complete",
  ]),
  current: count,
  total: count,
  bytes: count,
})
export type StorageStartupProgress = z.infer<typeof StorageStartupProgress>

export const RuntimeStartupProgress = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("starting") }).strict(),
  StorageStartupProgress.extend({ phase: z.literal("storage"), step: count.positive() })
    .strict()
    .refine((value) => value.total === 0 || value.current <= value.total),
  z.object({ phase: z.literal("recovery"), current: count }).strict(),
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
