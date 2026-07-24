import { deserialize, serialize } from "v8"
import z from "zod"
import type { ClassifyResult, PluginToolCapabilityMap } from "../gate"

export interface PolicyClassificationContext {
  activeWorkspace: string
  workspaceType: string
  registeredMcpTools: string[]
  registeredPluginTools: string[]
  pluginToolCapabilities: Record<string, PluginToolCapabilityMap>
  pluginApprovals?: Record<string, { approvedCapabilities: string[] }>
  originalCheckout?: string
  readRoots?: string[]
  trustedRoots?: string[]
  synergyRoot?: string
}

export interface PolicyClassificationInput {
  context: PolicyClassificationContext
  toolName: string
  args: Record<string, unknown>
}

export namespace PolicyWorkerProtocol {
  export const VERSION = 2
  export const REQUEST_MAX_BYTES = 16 * 1024 * 1024
  export const REQUEST_CHUNK_BYTES = 1024 * 1024
  export const IPC_FRAME_MAX_BYTES = 2 * 1024 * 1024
  export const ERROR_MESSAGE_MAX_CHARS = 8 * 1024
  export const WorkerMemory = z
    .object({
      rssBytes: z.number().nonnegative(),
      heapUsedBytes: z.number().nonnegative(),
      heapTotalBytes: z.number().nonnegative(),
      externalBytes: z.number().nonnegative(),
      arrayBuffersBytes: z.number().nonnegative(),
    })
    .strict()
  export type WorkerMemory = z.infer<typeof WorkerMemory>

  const PluginToolCapabilitySchema = z
    .object({
      capabilities: z.array(z.string()),
      risk: z.enum(["low", "medium", "high"]),
    })
    .strict()

  const ClassificationContextSchema = z
    .object({
      activeWorkspace: z.string(),
      workspaceType: z.string(),
      registeredMcpTools: z.array(z.string()),
      registeredPluginTools: z.array(z.string()),
      pluginToolCapabilities: z.record(z.string(), PluginToolCapabilitySchema),
      pluginApprovals: z
        .record(
          z.string(),
          z
            .object({
              approvedCapabilities: z.array(z.string()),
            })
            .strict(),
        )
        .optional(),
      originalCheckout: z.string().optional(),
      readRoots: z.array(z.string()).optional(),
      trustedRoots: z.array(z.string()).optional(),
      synergyRoot: z.string().optional(),
    })
    .strict()

  export const ClassificationInputSchema: z.ZodType<PolicyClassificationInput> = z
    .object({
      context: ClassificationContextSchema,
      toolName: z.string(),
      args: z.record(z.string(), z.unknown()),
    })
    .strict()

  const CapabilitySchema = z
    .object({
      class: z.string(),
      nonBypassable: z.boolean(),
      opaque: z.boolean().optional(),
      approved: z.boolean().optional(),
      paths: z.array(z.string()).optional(),
      reason: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()

  export const ClassifyResultSchema: z.ZodType<ClassifyResult> = z
    .object({
      capabilities: z.array(CapabilitySchema),
    })
    .strict()

  export type HostToWorker =
    | { type: "run-start"; requestId: string; totalBytes: number; chunkCount: number }
    | { type: "run-chunk"; requestId: string; index: number; data: Uint8Array }
    | { type: "run-commit"; requestId: string }
    | { type: "cancel"; requestId: string }
    | { type: "shutdown" }
    | { type: "ping" }

  export type WorkerToHost =
    | { type: "ready"; protocolVersion: number; pid: number; memory: WorkerMemory }
    | { type: "run-ready"; requestId: string }
    | { type: "chunk-ack"; requestId: string; index: number }
    | {
        type: "result"
        requestId: string
        result: ClassifyResult
        requests: number
        memoryBeforeRelease: WorkerMemory
        memoryAfterRelease: WorkerMemory
      }
    | { type: "released"; requestId: string; requests: number; memory: WorkerMemory }
    | { type: "error"; requestId: string; error: { name: string; message: string } }
    | {
        type: "heartbeat"
        requestId?: string
        requests: number
        memory: WorkerMemory
      }
    | { type: "pong" }

  export const HostToWorkerSchema: z.ZodType<HostToWorker> = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("run-start"),
        requestId: z.string(),
        totalBytes: z.number().int().nonnegative().max(REQUEST_MAX_BYTES),
        chunkCount: z
          .number()
          .int()
          .nonnegative()
          .max(Math.ceil(REQUEST_MAX_BYTES / REQUEST_CHUNK_BYTES)),
      })
      .strict(),
    z
      .object({
        type: z.literal("run-chunk"),
        requestId: z.string(),
        index: z.number().int().nonnegative(),
        data: z.custom<Uint8Array>(
          (value) => value instanceof Uint8Array && value.byteLength <= REQUEST_CHUNK_BYTES,
          "Invalid or oversized Policy worker request chunk",
        ),
      })
      .strict(),
    z.object({ type: z.literal("run-commit"), requestId: z.string() }).strict(),
    z.object({ type: z.literal("cancel"), requestId: z.string() }).strict(),
    z.object({ type: z.literal("shutdown") }).strict(),
    z.object({ type: z.literal("ping") }).strict(),
  ])

  export const WorkerToHostSchema: z.ZodType<WorkerToHost> = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("ready"),
        protocolVersion: z.number().int().positive(),
        pid: z.number().int().positive(),
        memory: WorkerMemory,
      })
      .strict(),
    z.object({ type: z.literal("run-ready"), requestId: z.string() }).strict(),
    z.object({ type: z.literal("chunk-ack"), requestId: z.string(), index: z.number().int().nonnegative() }).strict(),
    z
      .object({
        type: z.literal("result"),
        requestId: z.string(),
        result: ClassifyResultSchema,
        requests: z.number().int().nonnegative(),
        memoryBeforeRelease: WorkerMemory,
        memoryAfterRelease: WorkerMemory,
      })
      .strict(),
    z
      .object({
        type: z.literal("released"),
        requestId: z.string(),
        requests: z.number().int().nonnegative(),
        memory: WorkerMemory,
      })
      .strict(),
    z
      .object({
        type: z.literal("error"),
        requestId: z.string(),
        error: z.object({ name: z.string(), message: z.string() }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("heartbeat"),
        requestId: z.string().optional(),
        requests: z.number().int().nonnegative(),
        memory: WorkerMemory,
      })
      .strict(),
    z.object({ type: z.literal("pong") }).strict(),
  ])

  export function parseHostToWorker(value: unknown): HostToWorker {
    return HostToWorkerSchema.parse(value)
  }

  export function parseWorkerToHost(value: unknown): WorkerToHost {
    return WorkerToHostSchema.parse(value)
  }

  export function byteLength(value: unknown): number {
    try {
      return serialize(value).byteLength
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  export function assertIpcFrameBound(value: unknown): void {
    const bytes = byteLength(value)
    if (bytes <= IPC_FRAME_MAX_BYTES) return
    throw new Error(`Policy worker IPC frame exceeded ${IPC_FRAME_MAX_BYTES} bytes (${bytes} bytes)`)
  }

  export function serializeInput(value: PolicyClassificationInput): Uint8Array {
    const parsed = ClassificationInputSchema.parse(value)
    const bytes = serialize(parsed)
    if (bytes.byteLength <= REQUEST_MAX_BYTES) return bytes
    throw new Error(`Policy classification request exceeded ${REQUEST_MAX_BYTES} bytes (${bytes.byteLength} bytes)`)
  }

  export function deserializeInput(value: Uint8Array): PolicyClassificationInput {
    if (value.byteLength > REQUEST_MAX_BYTES) {
      throw new Error(`Policy classification request exceeded ${REQUEST_MAX_BYTES} bytes (${value.byteLength} bytes)`)
    }
    return ClassificationInputSchema.parse(deserialize(value))
  }

  export function serializeError(error: unknown): { name: string; message: string } {
    if (!(error instanceof Error)) {
      return { name: "Error", message: String(error).slice(0, ERROR_MESSAGE_MAX_CHARS) }
    }
    return {
      name: error.name || "Error",
      message: error.message.slice(0, ERROR_MESSAGE_MAX_CHARS),
    }
  }

  export function deserializeError(error: { name: string; message: string }): Error {
    return Object.assign(new Error(error.message), { name: error.name })
  }
}
