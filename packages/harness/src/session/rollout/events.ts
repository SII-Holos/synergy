import { z } from "zod"
import { BusEvent } from "../../bus/bus-event"
import { isDeepStrictEqual } from "node:util"
import { StorageIntegrityError } from "../../storage/errors"
import { RolloutSchema } from "./schema"

export namespace RolloutEvents {
  export const RecordCommitted = {
    type: "rollout.record.committed" as const,
    properties: z.strictObject({
      owner: RolloutSchema.Owner,
      revision: z.number().int().positive().safe(),
      time: z.number(),
      key: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1),
      value: z.json(),
    }),
  }

  export const Record = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("run"), value: RolloutSchema.RunRecord }),
      z.object({ kind: z.literal("segment"), value: RolloutSchema.ExecutionSegment }),
      z.object({ kind: z.literal("interval"), value: RolloutSchema.ExecutionInterval }),
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
    const kind = key.includes("intervals")
      ? "interval"
      : key.includes("attempts")
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

  /** Reads one original committed journal record without recovering or folding its owner. */
  export async function readCommitted(owner: RolloutSchema.Owner, revision: number): Promise<Record> {
    owner = RolloutSchema.Owner.parse(owner)
    revision = z.number().int().positive().safe().parse(revision)
    const { RolloutJournal } = await import("./journal")
    for await (const event of RolloutJournal.events(owner, revision, revision - 1)) {
      if (event.kind !== "record" || event.seq !== revision)
        throw new StorageIntegrityError("Committed Rollout record is missing its original evidence")
      const record = parse(event.key, event.value)
      if (!isDeepStrictEqual(record.value.owner, owner))
        throw new StorageIntegrityError("Committed Rollout record belongs to another native owner")
      return record
    }
    throw new StorageIntegrityError("Committed Rollout record is unavailable")
  }
}
