import { z } from "zod"

export namespace RolloutRecordKeys {
  const Segment = z.string().regex(/^[a-zA-Z0-9_-]+$/)
  export const run = (root: readonly string[], runID: string) => [...root, "runs", Segment.parse(runID)]
  export const runInfo = (root: readonly string[], runID: string) => [...run(root, runID), "info"]
  export const tool = (root: readonly string[], runID: string, toolID: string) => [
    ...run(root, runID),
    "tools",
    z.uuid().parse(toolID),
  ]
}
