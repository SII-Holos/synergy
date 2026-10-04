import { z } from "zod"
import type { RolloutSchema } from "./rollout/schema"

export namespace TurnExecutionState {
  export const Schema = z
    .object({
      rootID: z.string(),
      status: z.enum(["preparing", "running", "approval", "completed", "failed", "stopped", "interrupted"]),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      segmentID: z.string().optional(),
      stoppedAt: z.array(z.number()),
    })
    .strict()
    .meta({ ref: "TurnExecutionState" })
  export type Info = z.infer<typeof Schema>
  type Run = Pick<RolloutSchema.RunRecord, "id" | "status" | "started" | "ended">
  type Segment = Pick<RolloutSchema.ExecutionSegment, "id" | "status" | "started" | "ended">

  export function project(run: Run, segments: Segment[], pendingApproval = false): Info {
    const ordered = [...segments].sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
    const latest = ordered.at(-1)
    const status = run.status === "cancelled" ? "stopped" : run.status
    const stoppedAt = ordered
      .filter((segment) => segment.status === "cancelled")
      .map((segment) => segment.ended ?? segment.started)
    if (status === "stopped" && !stoppedAt.length) stoppedAt.push(run.ended ?? run.started)
    return {
      rootID: run.id,
      status: status === "running" && pendingApproval ? "approval" : status,
      startedAt: latest?.started ?? run.started,
      endedAt: run.ended,
      segmentID: latest?.id,
      stoppedAt,
    }
  }
}
