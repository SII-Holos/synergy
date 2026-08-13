import z from "zod"
import { ObservabilitySchema } from "./schema"

export namespace TelemetryProtocol {
  export const BATCH_CHUNK_ROWS = 1000

  export const WorkerConfigSchema = z
    .object({
      maxSqliteBytes: z.number().int().positive(),
      walCheckpointIntervalMs: z.number().int().min(1000),
      metricRetentionMs: z.number().int().min(60_000),
      traceRetentionMs: z.number().int().min(60_000),
      maintenanceBudgetMs: z.number().int().min(1),
    })
    .strict()
  export type WorkerConfig = z.infer<typeof WorkerConfigSchema>

  export const BrowserBatchRow = z.object({
    batchId: z.string(),
    receivedTime: z.number(),
    sentAt: z.number(),
    accepted: z.number(),
    rejected: z.number(),
    page: z.record(z.string(), z.unknown()),
  })
  export type BrowserBatchRow = z.infer<typeof BrowserBatchRow>

  export const BatchRowSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("metric"), row: ObservabilitySchema.Metric }),
    z.object({ kind: z.literal("event"), row: ObservabilitySchema.Event }),
    z.object({ kind: z.literal("span"), row: ObservabilitySchema.Span }),
    z.object({ kind: z.literal("resource"), row: ObservabilitySchema.ResourceSample }),
    z.object({ kind: z.literal("issue"), row: ObservabilitySchema.Issue }),
    z.object({ kind: z.literal("browser-batch"), row: BrowserBatchRow }),
  ])
  export type BatchRow = z.infer<typeof BatchRowSchema>

  export const HostToWorkerSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("start"), dbPath: z.string(), config: WorkerConfigSchema }),
    z.object({ type: z.literal("batch"), rows: z.array(BatchRowSchema).min(1) }),
    z.object({ type: z.literal("flush"), ackId: z.number().int().nonnegative() }),
    z.object({
      type: z.literal("interrupt-spans"),
      reason: z.enum(["previous_runtime_ended", "runtime_shutdown"]),
    }),
    z.object({ type: z.literal("retain-now") }),
    z.object({ type: z.literal("checkpoint") }),
    z.object({ type: z.literal("reconfigure"), config: WorkerConfigSchema }),
    z.object({ type: z.literal("shutdown") }),
  ])
  export type HostToWorker = z.infer<typeof HostToWorkerSchema>

  export const WorkerToHostSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready"), pid: z.number().int().positive() }),
    z.object({ type: z.literal("ack"), ackId: z.number().int().nonnegative() }),
    z.object({
      type: z.literal("status"),
      counters: z.object({
        dropped: z.number().int().nonnegative(),
        capExceededBytes: z.number().nonnegative(),
        maintenanceDeferred: z.boolean(),
        lastFlushDurationMs: z.number().nonnegative(),
        lastError: z.string().optional(),
      }),
    }),
  ])
  export type WorkerToHost = z.infer<typeof WorkerToHostSchema>

  export function parseHostToWorker(input: unknown): HostToWorker | undefined {
    const result = HostToWorkerSchema.safeParse(input)
    return result.success ? result.data : undefined
  }

  export function parseWorkerToHost(input: unknown): WorkerToHost | undefined {
    const result = WorkerToHostSchema.safeParse(input)
    return result.success ? result.data : undefined
  }
}
