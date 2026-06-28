import z from "zod"
import { Identifier } from "../id/id"

export namespace SuperPlanTypes {
  export const RunStatus = z.enum([
    "planning",
    "ready",
    "running",
    "waiting",
    "merging",
    "auditing",
    "completed",
    "failed",
    "cancelled",
  ])
  export type RunStatus = z.infer<typeof RunStatus>

  export const NodeStatus = z.enum([
    "pending",
    "ready",
    "running",
    "waiting",
    "auditing",
    "completed",
    "failed",
    "blocked",
    "cancelled",
  ])
  export type NodeStatus = z.infer<typeof NodeStatus>

  export const MergeStatus = z.enum(["pending", "running", "completed", "failed", "cancelled"])
  export type MergeStatus = z.infer<typeof MergeStatus>

  export const Node = z
    .object({
      id: Identifier.schema("superplan_node"),
      runID: Identifier.schema("superplan_run"),
      title: z.string(),
      description: z.string().optional(),
      deps: z.array(Identifier.schema("superplan_node")),
      blueprintNoteID: z.string().optional(),
      loopID: Identifier.schema("blueprint_loop").optional(),
      sessionID: Identifier.schema("session").optional(),
      worktreeID: z.string().optional(),
      baseCommit: z.string().optional(),
      resultCommit: z.string().optional(),
      status: NodeStatus,
      error: z.string().optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        started: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "SuperPlanNode" })
  export type Node = z.infer<typeof Node>

  export const Merge = z
    .object({
      id: Identifier.schema("superplan_merge"),
      runID: Identifier.schema("superplan_run"),
      wave: z.number().int().min(0),
      inputNodeIDs: z.array(Identifier.schema("superplan_node")),
      inputCommits: z.array(z.string()),
      sessionID: Identifier.schema("session").optional(),
      worktreeID: z.string().optional(),
      baseCommit: z.string().optional(),
      resultCommit: z.string().optional(),
      status: MergeStatus,
      summary: z.string().optional(),
      error: z.string().optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        started: z.number().optional(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "SuperPlanMerge" })
  export type Merge = z.infer<typeof Merge>

  export const Run = z
    .object({
      id: Identifier.schema("superplan_run"),
      scopeID: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: RunStatus,
      plannerSessionID: Identifier.schema("session").optional(),
      summarySessionID: Identifier.schema("session").optional(),
      baseCommit: z.string().optional(),
      currentMergeCommit: z.string().optional(),
      activeWave: z.number().int().min(0).optional(),
      nodes: z.array(Node),
      merges: z.array(Merge),
      error: z.string().optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        completed: z.number().optional(),
      }),
    })
    .meta({ ref: "SuperPlanRun" })
  export type Run = z.infer<typeof Run>

  export const EventKind = z.enum([
    "run_created",
    "run_updated",
    "node_started",
    "node_completed",
    "wave_ready",
    "merge_started",
    "merge_completed",
    "run_failed",
    "run_cancelled",
  ])
  export type EventKind = z.infer<typeof EventKind>

  export const EventInfo = z
    .object({
      id: Identifier.schema("superplan_event"),
      runID: Identifier.schema("superplan_run"),
      scopeID: z.string(),
      kind: EventKind,
      nodeID: Identifier.schema("superplan_node").optional(),
      mergeID: Identifier.schema("superplan_merge").optional(),
      message: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      time: z.object({
        created: z.number(),
      }),
    })
    .meta({ ref: "SuperPlanEvent" })
  export type EventInfo = z.infer<typeof EventInfo>
}
