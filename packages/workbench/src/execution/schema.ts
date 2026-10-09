import { z } from "zod"
import { RolloutAccounting, RolloutEvidence, RolloutSchema } from "@ericsanchezok/synergy-harness/rollout"
import { Usage } from "@ericsanchezok/synergy-harness/usage"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { CortexTypes } from "@ericsanchezok/synergy-harness/cortex/types"
import { ExecutionPresentation } from "./presentation"

export namespace ExecutionSchema {
  const Json = z.unknown().meta({ ref: "ExecutionJson" })
  export const Query = z.object({
    mode: z.enum(["process", "records"]).default("records"),
    order: z.enum(["time", "round", "call"]).default("time"),
    runID: z.string().optional(),
    session: z.string().optional(),
    actor: z.enum(["main", "all"]).default("main"),
    query: z.string().max(500).optional(),
    kind: z
      .enum([
        "turn",
        "input",
        "context",
        "reasoning",
        "output",
        "model",
        "retry",
        "tool",
        "process",
        "compaction",
        "subtask",
      ])
      .optional(),
    status: z.enum(["running", "completed", "failed", "cancelled", "interrupted", "unknown"]).optional(),
    kinds: z.string().max(200).optional(),
    statuses: z.string().max(100).optional(),
    anomalies: z.preprocess((value) => (value === "false" ? false : value), z.coerce.boolean()).default(false),
    from: z.coerce.number().nonnegative().optional(),
    to: z.coerce.number().nonnegative().optional(),
    activityFrom: z.coerce.number().int().nonnegative().optional(),
    activityTo: z.coerce.number().int().nonnegative().optional(),
    cursor: z.string().max(4096).optional(),
    anchor: z.string().optional(),
    position: z.enum(["before", "after", "around"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  export type Query = z.infer<typeof Query>
  export const Node = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      runID: z.string(),
      rootRunID: z.string().nullable().optional(),
      parentID: z.string().nullable(),
      kind: Query.shape.kind.unwrap(),
      title: z.string(),
      preview: z.string(),
      started: z.number(),
      ended: z.number().optional(),
      status: Query.shape.status.unwrap(),
      revision: z.number(),
      messageID: z.string().optional(),
      tool: z.string().optional(),
      modelID: z.string().optional(),
      modelKind: RolloutSchema.CallRecord.shape.kind,
      agent: z.string().optional(),
      callID: z.string().optional(),
      source: z.enum(["recorded", "messages"]),
      evidenceKind: RolloutEvidence.Kind.optional(),
      attemptIndex: z.number().int().nonnegative().optional(),
      purpose: z.string().optional(),
      usageRole: z.string().optional(),
      attribution: z.enum(["known", "unassigned"]).optional(),
      tokens: RolloutAccounting.Metric.optional(),
      group: z
        .object({
          id: z.string(),
          started: z.number().optional(),
          callCount: z.number().int().positive().optional(),
          memberCount: z.number(),
          attemptCount: z.number(),
          retryCount: z.number(),
          anomalies: z.number(),
          purpose: z.string().nullable(),
        })
        .optional(),
      ancestors: z.array(z.object({ id: z.string(), title: z.string(), kind: Query.shape.kind.unwrap() })).optional(),
      activity: z
        .object({ index: z.number(), count: z.number(), endIndex: z.number(), instruction: z.boolean() })
        .optional(),
    })
    .meta({ ref: "ExecutionTrajectoryNode" })
  export type Node = z.infer<typeof Node>
  export const Task = z
    .object({
      sessionID: z.string(),
      nodeID: z.string().nullable(),
      parentID: z.string().nullable(),
      title: z.string(),
      status: z.enum([
        "running",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "unknown",
        "queued",
        "paused",
        "waiting",
      ]),
      elapsedMs: z.number().nullable(),
      elapsedActive: z.boolean(),
      elapsedLowerBound: z.boolean(),
      tokens: RolloutAccounting.Metric,
      runs: z.array(z.string()),
      interaction: SessionInteraction.Info.optional(),
      cortex: z
        .object({
          taskID: CortexTypes.Task.shape.id,
          agent: CortexTypes.Task.shape.agent,
          status: CortexTypes.TaskStatus,
          visibility: CortexTypes.Task.shape.visibility,
        })
        .optional(),
    })
    .meta({ ref: "ExecutionTask" })
  export const ContextQuery = z.object({
    runID: z.string().optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  export const ContextSnapshot = z
    .object({
      sessionID: z.string(),
      callID: z.string(),
      nodeID: z.string(),
      runID: z.string(),
      started: z.number(),
      requestNumber: z.number().int().positive(),
      roundNumber: z.number().int().positive(),
      status: RolloutSchema.Status,
      modelID: z.string(),
      providerID: z.string(),
      inputTokens: z.number().nonnegative().nullable(),
      contextLimit: z.number().nonnegative().nullable(),
      outputTokens: z.number().nonnegative().nullable(),
      cacheHit: z.number().min(0).max(1).nullable(),
      elapsedMs: z.number().nonnegative().nullable(),
      retries: z.number().int().nonnegative(),
      usage: MessageV2.Assistant.shape.contextUsage.unwrap().nullable(),
      compactedBefore: z.boolean(),
      requestAvailable: z.boolean(),
    })
    .meta({ ref: "ExecutionContextSnapshot" })
  export type ContextSnapshot = z.infer<typeof ContextSnapshot>
  export const ContextHistory = z
    .object({
      sessionID: z.string(),
      revision: z.number(),
      total: z.number(),
      items: z.array(ContextSnapshot),
      nextCursor: z.string().nullable(),
    })
    .meta({ ref: "ExecutionContextHistory" })
  export const ContextItemsQuery = ContextQuery.extend({
    category: MessageV2.ContextSource.shape.category.optional(),
    query: z.string().max(500).optional(),
    version: z.string().max(4096).optional(),
  })
  export const ContextItem = MessageV2.ContextSource.extend({
    id: z.string(),
    offset: z.number().nonnegative(),
    bytes: z.number().nonnegative(),
  }).meta({ ref: "ExecutionContextItem" })
  export const ContextItems = z
    .object({
      callID: z.string(),
      nodeID: z.string(),
      contentVersion: z.string().nullable(),
      status: z.enum(["available", "legacy", "unavailable"]),
      items: z.array(ContextItem),
      total: z.number(),
      nextCursor: z.string().nullable(),
      truncated: z.boolean(),
    })
    .meta({ ref: "ExecutionContextItems" })
  export const Summary = z
    .object({
      sessionID: z.string(),
      revision: z.number(),
      runID: z.string().optional(),
      computedAt: z.number(),
      clockID: z.string(),
      sampledAt: z.number(),
      status: Task.shape.status,
      elapsedMs: z.number().nullable(),
      elapsedActive: z.boolean(),
      elapsedLowerBound: z.boolean(),
      accounting: RolloutAccounting.Summary,
      cost: ExecutionPresentation.Cost,
      own: RolloutAccounting.Summary,
      descendants: RolloutAccounting.Summary,
      rates: Usage.Summary.shape.rates,
      cache: Usage.Summary.shape.cache,
      latency: Usage.Summary.shape.latency,
      outcomes: Usage.Summary.shape.outcomes,
      tools: Usage.Summary.shape.tools,
      context: Usage.Summary.shape.context,
      contextDistribution: MessageV2.Assistant.shape.contextUsage.unwrap().nullable(),
      tasks: z.array(Task),
      rounds: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          started: z.number(),
          status: Task.shape.status,
          elapsedMs: z.number().nullable(),
          elapsedActive: z.boolean(),
          elapsedLowerBound: z.boolean(),
        }),
      ),
      coverage: z.object({ recorded: z.number(), messages: z.number(), gaps: z.number(), partial: z.boolean() }),
      lanes: z.array(
        z.object({
          kind: z.enum(["input", "model", "tool"]),
          start: z.number(),
          end: z.number(),
          nodes: z.array(Node),
          total: z.number(),
        }),
      ),
      activityTotal: z.number(),
      activitySegments: z
        .array(
          z.object({
            runID: z.string().nullable(),
            from: z.number(),
            to: z.number(),
            count: z.number(),
            rounds: z.number(),
          }),
        )
        .optional(),
      humanInputs: z.number(),
      taskInstructions: z.number(),
    })
    .meta({ ref: "ExecutionSummary" })
  export type Summary = z.infer<typeof Summary>
  export const Page = z
    .object({
      sessionID: z.string(),
      revision: z.number(),
      total: z.number(),
      items: z.array(Node),
      nextCursor: z.string().nullable(),
      previousCursor: z.string().nullable(),
    })
    .meta({ ref: "ExecutionTrajectoryPage" })
  export const Detail = z
    .object({
      node: Node,
      execution: Summary.pick({
        status: true,
        elapsedMs: true,
        elapsedActive: true,
        elapsedLowerBound: true,
        clockID: true,
        sampledAt: true,
        revision: true,
      }).optional(),
      record: Json.nullable(),
      sources: z.array(z.object({ field: z.string(), artifact: RolloutSchema.ArtifactRef })),
      definitions: Json.nullable(),
      related: z.array(Node),
    })
    .meta({ ref: "ExecutionNodeDetail" })
  export const Content = RolloutEvidence.Content
  export const Updated = BusEvent.define(
    "execution.updated",
    z.object({
      sessionID: z.string(),
      revision: z.number(),
      summary: Summary,
      roundSummaries: z.array(Summary),
      contextUpserts: z.array(ContextSnapshot).optional(),
      previousRevision: z.number().int().nonnegative().optional(),
      upserts: z.array(Node),
      processUpserts: z.array(Node).optional(),
      processRemoved: z.array(z.string()).optional(),
      removed: z.array(z.string()),
    }),
  )
}
