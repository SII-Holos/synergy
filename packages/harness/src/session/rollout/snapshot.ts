import z from "zod"
import { RolloutJournal } from "./journal"
import { RolloutSchema } from "./schema"

export namespace RolloutSnapshot {
  export const Info = z
    .object({
      version: z.literal(1),
      owner: RolloutSchema.Owner,
      revision: z.number().int().nonnegative(),
      gaps: z.array(z.number().int().positive()),
      runs: z.array(RolloutSchema.RunRecord),
      segments: z.array(RolloutSchema.ExecutionSegment),
      calls: z.array(RolloutSchema.CallRecord),
      attempts: z.array(RolloutSchema.AttemptRecord),
      tools: z.array(RolloutSchema.ToolExecutionRecord),
      processes: z.array(RolloutSchema.ProcessRecord),
    })
    .strict()
    .meta({ ref: "RolloutSnapshot" })
  export type Info = z.infer<typeof Info>

  export async function read(
    owner: RolloutSchema.Owner,
    options: { revision?: number; runID?: string; onProgress?: () => void } = {},
  ): Promise<Info> {
    const revision = options.revision ?? (await RolloutJournal.head(owner)).committed
    const snapshot: Info = {
      version: 1,
      owner: RolloutSchema.Owner.parse(owner),
      revision,
      gaps: [],
      runs: [],
      segments: [],
      calls: [],
      attempts: [],
      tools: [],
      processes: [],
    }
    const latest = new Map<string, Extract<RolloutJournal.Event, { kind: "record" }>>()
    for await (const event of RolloutJournal.events(owner, revision)) {
      options.onProgress?.()
      if (event.kind === "gap") {
        snapshot.gaps.push(event.seq)
        continue
      }
      if (event.key[0] !== "runs" || event.key.length < 3) throw new Error("Invalid rollout journal record path")
      if (options.runID !== undefined && event.key[1] !== options.runID) continue
      latest.set(event.key.join("/"), event)
    }
    function check(value: { owner: RolloutSchema.Owner; id: string; runID?: string }, key: string[]) {
      if (JSON.stringify(RolloutSchema.Owner.parse(value.owner)) !== JSON.stringify(snapshot.owner))
        throw new Error("Rollout record owner mismatch")
      const runID = value.runID ?? value.id
      if (runID !== key[1] || (value.runID !== undefined && value.id !== key.at(-1)))
        throw new Error("Rollout record identity mismatch")
    }
    for (const { key, value } of latest.values()) {
      if (key.length === 3 && key[2] === "info") {
        const run = RolloutSchema.RunRecord.parse(value)
        check(run, key)
        snapshot.runs.push(run)
      } else if (key.length === 4 && key[2] === "segments") {
        const segment = RolloutSchema.ExecutionSegment.parse(value)
        check(segment, key)
        snapshot.segments.push(segment)
      } else if (key.length === 4 && key[2] === "calls") {
        const call = RolloutSchema.CallRecord.parse(value)
        check(call, key)
        snapshot.calls.push(call)
      } else if (key.length === 5 && key[2] === "attempts") {
        const attempt = RolloutSchema.AttemptRecord.parse(value)
        check(attempt, key)
        if (attempt.callID !== key[3]) throw new Error("Rollout attempt call mismatch")
        snapshot.attempts.push(attempt)
      } else if (key.length === 4 && key[2] === "tools") {
        const tool = RolloutSchema.ToolExecutionRecord.parse(value)
        check(tool, key)
        snapshot.tools.push(tool)
      } else if (key.length === 4 && key[2] === "processes") {
        const process = RolloutSchema.ProcessRecord.parse(value)
        check(process, key)
        snapshot.processes.push(process)
      } else throw new Error("Unknown rollout journal record")
      options.onProgress?.()
    }
    return snapshot
  }
}
