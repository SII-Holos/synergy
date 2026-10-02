import { z } from "zod"
import { BusEvent } from "../../bus/bus-event"
import { RolloutSchema } from "./schema"

export namespace RolloutEvents {
  export const Record = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("run"), value: RolloutSchema.RunRecord }),
      z.object({ kind: z.literal("segment"), value: RolloutSchema.ExecutionSegment }),
      z.object({ kind: z.literal("call"), value: RolloutSchema.CallRecord }),
      z.object({ kind: z.literal("attempt"), value: RolloutSchema.AttemptRecord }),
      z.object({ kind: z.literal("tool"), value: RolloutSchema.ToolExecutionRecord }),
      z.object({ kind: z.literal("process"), value: RolloutSchema.ProcessRecord }),
    ])
    .meta({ ref: "RolloutEvidenceRecord" })
  export type Record = z.infer<typeof Record>
  export const Updated = BusEvent.define(
    "rollout.updated",
    z.object({
      owner: RolloutSchema.Owner,
      revision: z.number().int().nonnegative(),
      record: Record,
    }),
  )

  export function parse(key: string[], value: unknown) {
    const kind = key.includes("attempts")
      ? "attempt"
      : key.includes("calls")
        ? "call"
        : key.includes("tools")
          ? "tool"
          : key.includes("processes")
            ? "process"
            : key.includes("segments")
              ? "segment"
              : "run"
    return Record.parse({ kind, value })
  }
}
