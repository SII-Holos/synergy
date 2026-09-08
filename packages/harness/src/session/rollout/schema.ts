import { RolloutProvenance } from "./provenance"
import { JsonValue } from "../../util/json-value"
import { RolloutAccounting } from "./accounting"
import { ProviderPricing } from "../../provider/pricing"
import { RolloutUsage } from "./usage"
import z from "zod"
import { Experiment } from "../../config/experiment"

export namespace RolloutSchema {
  const Segment = z.string().regex(/^[a-zA-Z0-9_-]+$/)
  export const Owner = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session"), scopeID: Segment, sessionID: Segment }).strict(),
    z.object({ kind: z.literal("operation"), scopeID: Segment, operationID: Segment }).strict(),
  ])
  export type Owner = z.infer<typeof Owner>

  export const MessageAccounting = z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("rollout"), callIDs: z.array(Segment), summary: RolloutAccounting.Summary.optional() })
      .strict(),
    z.object({ kind: z.literal("legacy"), calculation: z.literal("session-v0") }).strict(),
    z
      .object({
        kind: z.enum(["inherited", "imported"]),
        source: z.object({ sessionID: Segment, messageID: Segment, callIDs: z.array(Segment) }).strict(),
      })
      .strict(),
  ])

  export const ArtifactRef = z
    .object({
      version: z.literal(1),
      id: z.uuid(),
      mediaType: z.string(),
      bytes: z.number().int().nonnegative(),
      chunks: z.number().int().nonnegative(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      status: z.enum(["partial", "complete"]),
    })
    .strict()
    .meta({ ref: "RolloutArtifactRef" })
  export type ArtifactRef = z.infer<typeof ArtifactRef>

  export const Status = z.enum(["running", "completed", "failed", "cancelled", "interrupted"])
  export const RunRecord = z
    .object({
      version: z.literal(1),
      id: Segment,
      owner: Owner,
      started: z.number(),
      ended: z.number().optional(),
      status: Status,
      recording: z.enum(["partial", "complete", "failed"]),
      input: ArtifactRef.optional(),
      attachments: z.array(ArtifactRef).optional(),
      configuration: Experiment.Snapshot.optional(),
      provenance: RolloutProvenance.Info.optional(),
      initialHistory: z
        .object({ messages: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .optional(),
      source: z.object({ owner: Owner, runID: Segment }).strict().optional(),
      cancelRequestedAt: z.number().optional(),
      parent: z.object({ owner: Owner, runID: Segment.nullable(), messageID: Segment }).strict().optional(),
    })
    .strict()
    .meta({ ref: "RolloutRunRecord" })
  export type RunRecord = z.infer<typeof RunRecord>

  export const ExecutionSegment = z
    .object({
      version: z.literal(1),
      id: z.uuid(),
      owner: Owner,
      runID: Segment,
      started: z.number(),
      ended: z.number().optional(),
      status: Status,
    })
    .strict()
  export type ExecutionSegment = z.infer<typeof ExecutionSegment>

  export const ToolExecutionRecord = z
    .object({
      version: z.literal(1),
      id: z.uuid(),
      owner: Owner,
      runID: Segment,
      messageID: Segment,
      toolCallID: z.string(),
      tool: z.string(),
      started: z.number(),
      ended: z.number().optional(),
      status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
      input: ArtifactRef,
      authorization: ArtifactRef.optional(),
      rawResult: ArtifactRef.optional(),
      observation: ArtifactRef.optional(),
      error: z.string().optional(),
    })
    .strict()
    .meta({ ref: "RolloutToolExecutionRecord" })
  export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecord>

  export const ProcessRecord = z
    .object({
      version: z.literal(1),
      id: Segment,
      owner: Owner,
      runID: Segment,
      toolExecutionID: z.uuid(),
      started: z.number(),
      ended: z.number().optional(),
      status: z.enum(["running", "completed", "interrupted", "failed"]),
      stream: ArtifactRef,
      pid: z.number().int().optional(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
    })
    .strict()
  export type ProcessRecord = z.infer<typeof ProcessRecord>

  export const Model = z
    .object({
      providerID: z.string(),
      modelID: z.string(),
      sdk: z.string(),
      pricing: ProviderPricing.Info.nullable(),
    })
    .strict()

  export const CallRecord = z
    .object({
      version: z.literal(1),
      source: z.object({ owner: Owner, runID: Segment, callID: Segment }).strict().optional(),
      id: Segment,
      runID: Segment,
      owner: Owner,
      purpose: z.string(),
      kind: z.enum(["chat", "embedding", "rerank", "transcription", "speech"]).optional(),
      execution: z.enum(["provider", "local", "external"]).optional(),
      parentCallID: Segment.optional(),
      agent: z.string().optional(),
      model: Model,
      started: z.number(),
      ended: z.number().optional(),
      status: Status,
      request: ArtifactRef,
      response: ArtifactRef.optional(),
      sdkUsage: JsonValue.nullable(),
      transportCaptured: z.boolean(),
      error: z.string().optional(),
    })
    .strict()
    .meta({ ref: "RolloutCallRecord" })
  export type CallRecord = z.infer<typeof CallRecord>

  export const AttemptRecord = z
    .object({
      version: z.literal(1),
      id: z.uuid(),
      callID: Segment,
      runID: Segment,
      owner: Owner,
      index: z.number().int().nonnegative(),
      url: z.string(),
      method: z.string(),
      started: z.number(),
      ended: z.number().optional(),
      status: Status,
      request: ArtifactRef,
      response: ArtifactRef.optional(),
      httpStatus: z.number().int().optional(),
      usage: RolloutUsage.Info.optional(),
      estimate: ProviderPricing.Estimate.optional(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      error: z.string().optional(),
    })
    .strict()
    .meta({ ref: "RolloutAttemptRecord" })
  export type AttemptRecord = z.infer<typeof AttemptRecord>
}
