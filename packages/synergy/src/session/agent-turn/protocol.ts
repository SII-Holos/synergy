import z from "zod"
import { deserialize, serialize } from "v8"
import { APICallError, type FinishReason, type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Runtime as ScopeRuntime } from "@/scope/types"
import { Workspace } from "../workspace-schema"

export namespace AgentTurnProtocol {
  export const VERSION = 2
  export const REQUEST_MAX_BYTES = 64 * 1024 * 1024
  export const EVENT_MAX_BYTES = 2 * 1024 * 1024
  export const IPC_FRAME_MAX_BYTES = 2 * 1024 * 1024
  export const REQUEST_CHUNK_BYTES = 1024 * 1024
  export const ERROR_MESSAGE_MAX_CHARS = 64 * 1024
  export const ERROR_STACK_MAX_CHARS = 16 * 1024
  export const ERROR_RESPONSE_MAX_CHARS = 256 * 1024
  export const ERROR_DATA_MAX_BYTES = 256 * 1024

  const SerializedCause = z
    .object({
      name: z.string(),
      message: z.string(),
      code: z.string().optional(),
      syscall: z.string().optional(),
    })
    .strict()

  export const SerializedError = z
    .object({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
      code: z.string().optional(),
      syscall: z.string().optional(),
      data: z.unknown().optional(),
      statusCode: z.number().int().optional(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      isRetryable: z.boolean().optional(),
      cause: SerializedCause.optional(),
    })
    .strict()
  export type SerializedError = z.infer<typeof SerializedError>
  const EventError = z
    .object({
      __synergyAgentError: z.literal(true),
      error: SerializedError,
    })
    .strict()
  const ProviderMetadataSchema = z.custom<ProviderMetadata>(
    (value) => value !== null && typeof value === "object",
    "Invalid provider metadata",
  )
  const UsageSchema = z.custom<LanguageModelUsage>(
    (value) => value !== null && typeof value === "object",
    "Invalid language model usage",
  )
  const FinishReasonSchema = z.custom<FinishReason>((value) => typeof value === "string", "Invalid finish reason")
  const metadata = {
    providerMetadata: ProviderMetadataSchema.optional(),
  }

  export const StreamEventSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("start") }).strict(),
    z.object({ type: z.literal("reasoning-start"), id: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("reasoning-delta"), id: z.string(), text: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("reasoning-end"), id: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("tool-input-start"), id: z.string(), toolName: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("tool-input-delta"), id: z.string(), delta: z.string() }).strict(),
    z.object({ type: z.literal("tool-input-end"), id: z.string() }).strict(),
    z
      .object({
        type: z.literal("tool-call"),
        toolCallId: z.string(),
        toolName: z.string(),
        input: z.unknown(),
        ...metadata,
      })
      .strict(),
    z.object({ type: z.literal("tool-result"), toolCallId: z.string() }).strict(),
    z
      .object({ type: z.literal("tool-error"), toolCallId: z.string(), toolName: z.string(), error: z.unknown() })
      .strict(),
    z.object({ type: z.literal("error"), error: z.unknown() }).strict(),
    z.object({ type: z.literal("start-step") }).strict(),
    z
      .object({
        type: z.literal("finish-step"),
        finishReason: FinishReasonSchema,
        usage: UsageSchema,
        ...metadata,
      })
      .strict(),
    z.object({ type: z.literal("text-start"), id: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("text-delta"), id: z.string(), text: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("text-end"), id: z.string(), ...metadata }).strict(),
    z.object({ type: z.literal("finish") }).strict(),
    z.object({ type: z.literal("abort") }).strict(),
  ])
  export type StreamEvent = z.infer<typeof StreamEventSchema>

  export const TurnInputSchema = z
    .object({
      user: z.object({ id: z.string() }).strict(),
      sessionID: z.string(),
      model: z.object({ id: z.string(), providerID: z.string() }).passthrough(),
      agent: z.object({ name: z.string() }).strict(),
      system: z.array(z.string()),
      systemCacheBreakpoint: z.number().int().nonnegative().optional(),
      lateSystem: z.array(z.string()).optional(),
      messages: z.array(z.unknown()),
      small: z.boolean().optional(),
      toolDefinitions: z.array(
        z
          .object({
            id: z.string(),
            description: z.string(),
            inputSchema: z.record(z.string(), z.unknown()),
          })
          .strict(),
      ),
      activeToolIDs: z.array(z.string()).optional(),
      retries: z.number().int().nonnegative().optional(),
      contextUsageProvenance: z.unknown().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      prepared: z
        .object({
          system: z.array(z.string()),
          baseSystemLength: z.number().int().nonnegative(),
          provider: z
            .object({
              key: z.string().optional(),
              options: z.record(z.string(), z.unknown()),
              timeouts: z
                .object({
                  ttfbMs: z.number().nonnegative(),
                  idleMs: z.union([z.number().nonnegative(), z.literal(false)]),
                  wallMs: z.union([z.number().nonnegative(), z.literal(false)]),
                })
                .strict(),
            })
            .strict(),
          params: z
            .object({
              temperature: z.number().optional(),
              topP: z.number().optional(),
              topK: z.number().optional(),
              options: z.record(z.string(), z.unknown()),
            })
            .strict(),
          telemetryEnabled: z.boolean().optional(),
        })
        .strict(),
    })
    .strict()

  export const TurnEnvelopeSchema = z
    .object({
      scope: ScopeRuntime,
      workspace: Workspace.optional(),
      input: TurnInputSchema,
    })
    .strict()
  export type TurnEnvelope = z.infer<typeof TurnEnvelopeSchema>

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

  export type HostToWorker =
    | { type: "run-start"; requestId: string; totalBytes: number; chunkCount: number }
    | { type: "run-chunk"; requestId: string; index: number; data: Uint8Array }
    | { type: "run-commit"; requestId: string }
    | { type: "cancel"; requestId: string; reason?: string }
    | { type: "ack"; requestId: string; sequence: number }
    | { type: "shutdown" }
    | { type: "ping" }

  export type WorkerToHost =
    | { type: "ready"; protocolVersion: number; pid: number; memory: WorkerMemory }
    | { type: "run-ready"; requestId: string }
    | { type: "chunk-ack"; requestId: string; index: number }
    | { type: "started"; requestId: string; contextUsageDraft?: unknown }
    | { type: "events"; requestId: string; sequence: number; events: StreamEvent[] }
    | {
        type: "complete"
        requestId: string
        turns: number
        memoryBeforeDispose: WorkerMemory
        memory: WorkerMemory
        usage?: unknown
      }
    | {
        type: "error"
        requestId: string
        error: SerializedError
        memoryBeforeDispose?: WorkerMemory
        memory?: WorkerMemory
      }
    | {
        type: "heartbeat"
        requestId?: string
        turns: number
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
          "Invalid or oversized Agent turn request chunk",
        ),
      })
      .strict(),
    z.object({ type: z.literal("run-commit"), requestId: z.string() }).strict(),
    z
      .object({
        type: z.literal("cancel"),
        requestId: z.string(),
        reason: z.string().max(ERROR_MESSAGE_MAX_CHARS).optional(),
      })
      .strict(),
    z.object({ type: z.literal("ack"), requestId: z.string(), sequence: z.number().int().nonnegative() }).strict(),
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
        type: z.literal("started"),
        requestId: z.string(),
        contextUsageDraft: z.unknown().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("events"),
        requestId: z.string(),
        sequence: z.number().int().nonnegative(),
        events: z.array(StreamEventSchema),
      })
      .strict(),
    z
      .object({
        type: z.literal("complete"),
        requestId: z.string(),
        turns: z.number().int().nonnegative(),
        memoryBeforeDispose: WorkerMemory,
        memory: WorkerMemory,
        usage: z.unknown().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("error"),
        requestId: z.string(),
        error: SerializedError,
        memoryBeforeDispose: WorkerMemory.optional(),
        memory: WorkerMemory.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("heartbeat"),
        requestId: z.string().optional(),
        turns: z.number().int().nonnegative(),
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
    const seen = new WeakSet<object>()
    const measure = (item: unknown): number => {
      if (item === null || item === undefined) return 4
      if (typeof item === "string") return Buffer.byteLength(item, "utf8") + 2
      if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
        return Buffer.byteLength(String(item), "utf8")
      }
      if (item instanceof Uint8Array) return item.byteLength + 32
      if (item instanceof ArrayBuffer) return item.byteLength + 32
      if (item instanceof Error) return measure(serializeError(item))
      if (typeof item !== "object") return 0
      if (seen.has(item)) return 0
      seen.add(item)
      if (Array.isArray(item)) return 2 + item.reduce((sum, value) => sum + measure(value) + 1, 0)
      return (
        2 +
        Object.entries(item).reduce(
          (sum, [key, value]) => sum + Buffer.byteLength(key, "utf8") + 3 + measure(value) + 1,
          0,
        )
      )
    }
    return measure(value)
  }

  export function assertRequestBound(value: unknown): void {
    const bytes = byteLength(value)
    if (bytes <= REQUEST_MAX_BYTES) return
    throw new Error(`Agent turn request exceeded ${REQUEST_MAX_BYTES} bytes (${bytes} bytes)`)
  }

  export function assertEventFrameBound(value: unknown): void {
    const bytes = byteLength(value)
    if (bytes <= EVENT_MAX_BYTES) return
    throw new Error(`Agent turn event frame exceeded ${EVENT_MAX_BYTES} bytes (${bytes} bytes)`)
  }

  export function assertIpcFrameBound(value: unknown): void {
    const bytes = byteLength(value)
    if (bytes <= IPC_FRAME_MAX_BYTES) return
    throw new Error(`Agent worker IPC frame exceeded ${IPC_FRAME_MAX_BYTES} bytes (${bytes} bytes)`)
  }

  export function serializeTurn(value: TurnEnvelope): Uint8Array {
    const parsed = TurnEnvelopeSchema.parse(value)
    const bytes = serialize(parsed)
    if (bytes.byteLength <= REQUEST_MAX_BYTES) return bytes
    throw new Error(`Agent turn request exceeded ${REQUEST_MAX_BYTES} bytes (${bytes.byteLength} bytes)`)
  }

  export function deserializeTurn(value: Uint8Array): TurnEnvelope {
    if (value.byteLength > REQUEST_MAX_BYTES) {
      throw new Error(`Agent turn request exceeded ${REQUEST_MAX_BYTES} bytes (${value.byteLength} bytes)`)
    }
    return TurnEnvelopeSchema.parse(deserialize(value))
  }

  export function serializeError(error: unknown): SerializedError {
    if (!(error instanceof Error)) {
      return {
        name: "Error",
        message: String(error).slice(0, ERROR_MESSAGE_MAX_CHARS),
      }
    }
    const code =
      "code" in error && error.code !== undefined ? String(error.code).slice(0, ERROR_MESSAGE_MAX_CHARS) : undefined
    const syscall =
      "syscall" in error && error.syscall !== undefined
        ? String(error.syscall).slice(0, ERROR_MESSAGE_MAX_CHARS)
        : undefined
    const statusCode =
      "statusCode" in error && typeof error.statusCode === "number" && Number.isInteger(error.statusCode)
        ? error.statusCode
        : undefined
    const responseHeaders =
      "responseHeaders" in error && error.responseHeaders && typeof error.responseHeaders === "object"
        ? Object.fromEntries(
            Object.entries(error.responseHeaders as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([key, value]) => [key, value.slice(0, ERROR_MESSAGE_MAX_CHARS)]),
          )
        : undefined
    const responseBody =
      "responseBody" in error && typeof error.responseBody === "string"
        ? error.responseBody.slice(0, ERROR_RESPONSE_MAX_CHARS)
        : undefined
    const isRetryable = "isRetryable" in error && typeof error.isRetryable === "boolean" ? error.isRetryable : undefined
    const data = "data" in error ? boundedSerializable(error.data, ERROR_DATA_MAX_BYTES) : undefined
    const cause = "cause" in error ? serializeCause(error.cause) : undefined
    return {
      name: error.name || "Error",
      message: error.message.slice(0, ERROR_MESSAGE_MAX_CHARS),
      stack: error.stack?.slice(0, ERROR_STACK_MAX_CHARS),
      code,
      syscall,
      data,
      statusCode,
      responseHeaders,
      responseBody,
      isRetryable,
      cause,
    }
  }

  export function deserializeError(error: SerializedError): Error & { code?: unknown } {
    const cause = error.cause
      ? Object.assign(new Error(error.cause.message), {
          name: error.cause.name,
          code: error.cause.code,
          syscall: error.cause.syscall,
        })
      : undefined
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      const result = Object.assign(new DOMException(error.message, error.name), {
        syscall: error.syscall,
        data: error.data,
        cause,
      })
      if (error.stack) result.stack = error.stack
      return result
    }
    if (error.name === "AI_APICallError") {
      const result = new APICallError({
        message: error.message,
        url: "",
        requestBodyValues: {},
        statusCode: error.statusCode,
        responseHeaders: error.responseHeaders,
        responseBody: error.responseBody,
        isRetryable: error.isRetryable,
        data: error.data,
        cause,
      })
      if (error.stack) result.stack = error.stack
      return result
    }
    return Object.assign(new Error(error.message), {
      name: error.name,
      stack: error.stack,
      ...(error.code ? { code: error.code } : {}),
      syscall: error.syscall,
      data: error.data,
      statusCode: error.statusCode,
      responseHeaders: error.responseHeaders,
      responseBody: error.responseBody,
      isRetryable: error.isRetryable,
      cause,
    })
  }

  export function encodeEvents(events: readonly unknown[]): StreamEvent[] {
    return projectEvents(events).map((projected) => {
      if ((projected.type !== "error" && projected.type !== "tool-error") || projected.error === undefined) {
        return projected
      }
      return {
        ...projected,
        error: {
          __synergyAgentError: true,
          error: serializeError(projected.error),
        },
      }
    })
  }

  export function projectEvents(events: readonly unknown[]): StreamEvent[] {
    return events.flatMap((event) => {
      const projected = projectEvent(event)
      return projected ? [projected] : []
    })
  }

  export function decodeEvents(events: readonly StreamEvent[]): StreamEvent[] {
    return events.map((event) => {
      if (!("error" in event)) return event
      const encoded = EventError.safeParse(event.error)
      if (!encoded.success) return event
      return {
        ...event,
        error: deserializeError(encoded.data.error),
      }
    })
  }

  function projectEvent(event: unknown): StreamEvent | undefined {
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") return
    const value = event as Record<string, unknown>
    const providerMetadata =
      value.providerMetadata === undefined
        ? {}
        : {
            providerMetadata: value.providerMetadata as ProviderMetadata,
          }
    switch (event.type) {
      case "start":
      case "start-step":
      case "finish":
      case "abort":
        return { type: event.type }
      case "reasoning-start":
      case "reasoning-end":
      case "text-start":
      case "text-end":
        return {
          type: event.type,
          id: value.id as string,
          ...providerMetadata,
        }
      case "reasoning-delta":
      case "text-delta":
        return {
          type: event.type,
          id: value.id as string,
          text: value.text as string,
          ...providerMetadata,
        }
      case "tool-input-start":
        return {
          type: event.type,
          id: value.id as string,
          toolName: value.toolName as string,
          ...providerMetadata,
        }
      case "tool-input-delta":
        return {
          type: event.type,
          id: value.id as string,
          delta: value.delta as string,
        }
      case "tool-input-end":
        return {
          type: event.type,
          id: value.id as string,
        }
      case "tool-call":
        return {
          type: event.type,
          toolCallId: value.toolCallId as string,
          toolName: value.toolName as string,
          input: value.input,
          ...providerMetadata,
        }
      case "tool-result":
        return {
          type: event.type,
          toolCallId: value.toolCallId as string,
        }
      case "tool-error":
        return {
          type: event.type,
          toolCallId: value.toolCallId as string,
          toolName: value.toolName as string,
          error: value.error,
        }
      case "error":
        return {
          type: event.type,
          error: value.error,
        }
      case "finish-step":
        return {
          type: event.type,
          finishReason: value.finishReason as FinishReason,
          usage: value.usage as LanguageModelUsage,
          ...providerMetadata,
        }
      default:
        return
    }
  }

  function boundedSerializable(value: unknown, maxBytes: number): unknown {
    try {
      const bytes = serialize(value)
      if (bytes.byteLength > maxBytes) return undefined
      return deserialize(bytes)
    } catch {
      return undefined
    }
  }

  function serializeCause(value: unknown): z.infer<typeof SerializedCause> | undefined {
    if (!(value instanceof Error)) return undefined
    return {
      name: value.name || "Error",
      message: value.message.slice(0, ERROR_MESSAGE_MAX_CHARS),
      code:
        "code" in value && value.code !== undefined ? String(value.code).slice(0, ERROR_MESSAGE_MAX_CHARS) : undefined,
      syscall:
        "syscall" in value && value.syscall !== undefined
          ? String(value.syscall).slice(0, ERROR_MESSAGE_MAX_CHARS)
          : undefined,
    }
  }
}
