import z from "zod"
import { deserialize, serialize } from "v8"
import { APICallError } from "ai"

export namespace AgentTurnProtocol {
  export const VERSION = 1
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
      scope: z.unknown(),
      workspace: z.unknown().optional(),
      input: TurnInputSchema,
    })
    .strict()
  export type TurnEnvelope = z.infer<typeof TurnEnvelopeSchema>

  export type HostToWorker =
    | { type: "run-start"; requestId: string; totalBytes: number; chunkCount: number }
    | { type: "run-chunk"; requestId: string; index: number; data: Uint8Array }
    | { type: "run-commit"; requestId: string }
    | { type: "cancel"; requestId: string; reason?: string }
    | { type: "ack"; requestId: string; sequence: number }
    | { type: "shutdown" }
    | { type: "ping" }

  export type WorkerToHost =
    | { type: "ready"; protocolVersion: number; pid: number }
    | { type: "run-ready"; requestId: string }
    | { type: "chunk-ack"; requestId: string; index: number }
    | { type: "started"; requestId: string; contextUsageDraft?: unknown }
    | { type: "events"; requestId: string; sequence: number; events: unknown[] }
    | {
        type: "complete"
        requestId: string
        turns: number
        memory: { rssBytes: number; heapUsedBytes: number }
        usage?: unknown
      }
    | { type: "error"; requestId: string; error: SerializedError }
    | {
        type: "heartbeat"
        requestId?: string
        turns: number
        memory: { rssBytes: number; heapUsedBytes: number }
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
        events: z.array(z.unknown()),
      })
      .strict(),
    z
      .object({
        type: z.literal("complete"),
        requestId: z.string(),
        turns: z.number().int().nonnegative(),
        memory: z.object({ rssBytes: z.number().nonnegative(), heapUsedBytes: z.number().nonnegative() }).strict(),
        usage: z.unknown().optional(),
      })
      .strict(),
    z.object({ type: z.literal("error"), requestId: z.string(), error: SerializedError }).strict(),
    z
      .object({
        type: z.literal("heartbeat"),
        requestId: z.string().optional(),
        turns: z.number().int().nonnegative(),
        memory: z.object({ rssBytes: z.number().nonnegative(), heapUsedBytes: z.number().nonnegative() }).strict(),
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

  export function encodeEvents(events: readonly unknown[]): unknown[] {
    return events.map((event) => {
      if (!event || typeof event !== "object" || !("type" in event)) return event
      if ((event.type !== "error" && event.type !== "tool-error") || !("error" in event) || event.error === undefined) {
        return event
      }
      return {
        ...event,
        error: {
          __synergyAgentError: true,
          error: serializeError(event.error),
        },
      }
    })
  }

  export function decodeEvents(events: readonly unknown[]): unknown[] {
    return events.map((event) => {
      if (!event || typeof event !== "object" || !("error" in event)) return event
      const encoded = EventError.safeParse(event.error)
      if (!encoded.success) return event
      return {
        ...event,
        error: deserializeError(encoded.data.error),
      }
    })
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
