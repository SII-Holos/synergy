import { BusEvent } from "@/bus/bus-event"
import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Identifier } from "../id/id"
import { LSPSchema } from "../lsp/schema"
import { SnapshotSchema } from "@/session/snapshot-schema"
import { fn } from "@/util/fn"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { ProviderTransform } from "@/provider/transform"
import { ProviderAuthRecoveryError } from "@/provider/auth-recovery-error"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { type SystemError } from "bun"
import type { Scope } from "@/scope"
import { Attachment } from "@/attachment"
import { Asset } from "@/asset/asset"
import { Log } from "@/util/log"
import { SessionBounds } from "./bounds"
import { ContextUsageSchema } from "./context-usage-schema"

function isTLSError(message: string) {
  return /certificate|SSL|TLS|ERR_SSL|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|DEPTH_ZERO|self[- ]signed/i.test(message)
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ECONNABORTED",
  "EAI_AGAIN",
])

function systemErrorCode(error: unknown) {
  const code = (error as Partial<SystemError> | undefined)?.code
  return typeof code === "string" ? code : undefined
}

function retryableNetworkMessage(message: string) {
  return (
    /^(fetch failed|failed to fetch)$/i.test(message) ||
    /unable to connect\. is the computer able to access the url\?/i.test(message) ||
    /^(network error|connection error)$/i.test(message)
  )
}

function isRetryableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = systemErrorCode(error)
  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return true
  return retryableNetworkMessage(error.message)
}

function networkErrorMetadata(error: Error) {
  const metadata: Record<string, string> = {
    message: error.message,
  }
  const code = systemErrorCode(error)
  if (code) metadata.code = code
  const syscall = (error as Partial<SystemError>).syscall
  if (typeof syscall === "string") metadata.syscall = syscall
  return metadata
}
export namespace MessageV2 {
  const log = Log.create({ service: "message-v2" })

  type SessionLookup = {
    scope: Scope
  }

  let requireSession = async (sessionID: string): Promise<SessionLookup> => {
    throw new Error(`Session resolver is not installed for ${sessionID}`)
  }

  export function installSessionResolver(resolver: (sessionID: string) => Promise<SessionLookup>) {
    requireSession = resolver
  }

  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
      failureCode: z.string().optional(),
      actionRequired: z.boolean().optional(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>
  export const SessionTerminalError = NamedError.create(
    "SessionTerminalError",
    z.object({
      message: z.string(),
      errorName: z.string(),
    }),
  )
  export type SessionTerminalError = z.infer<typeof SessionTerminalError.Schema>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    /** @deprecated Superseded by `origin`; read only as a fallback by isSystemPart. No writes. */
    synthetic: z.boolean().optional(),
    origin: z.enum(["user", "system"]).optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const AttachmentSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "AttachmentSourceText",
      }),
  })

  export const FileSource = AttachmentSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = AttachmentSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSPSchema.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = AttachmentSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const AttachmentSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "AttachmentSource",
  })

  export const AttachmentPresentation = z
    .object({
      hidden: z.boolean().optional(),
      renderer: z.enum(["image", "video", "audio", "thumbnail", "file"]).optional(),
      size: z.enum(["original", "small", "medium", "large"]).optional(),
      crop: z.boolean().optional(),
    })
    .meta({
      ref: "AttachmentPresentation",
    })
  export type AttachmentPresentation = z.infer<typeof AttachmentPresentation>

  export const AttachmentModelPolicy = z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("summary"),
        summary: z.string().optional(),
      }),
      z.object({
        mode: z.literal("content"),
        text: z.string().optional(),
      }),
      z.object({
        mode: z.literal("provider-file"),
        summary: z.string().optional(),
      }),
      z.object({
        mode: z.literal("none"),
      }),
    ])
    .meta({
      ref: "AttachmentModelPolicy",
    })
  export type AttachmentModelPolicy = z.infer<typeof AttachmentModelPolicy>

  export const AttachmentPart = PartBase.extend({
    type: z.literal("attachment"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    localPath: z.string().optional(),
    source: AttachmentSource.optional(),
    presentation: AttachmentPresentation.optional(),
    model: AttachmentModelPolicy.optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "AttachmentPart",
  })
  export type AttachmentPart = z.infer<typeof AttachmentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const CompactionRecoveryPart = PartBase.extend({
    type: z.literal("compaction_recovery"),
    summary: z.string(),
    mechanical: z.boolean(),
    recoverySessionIDs: z.string().array().optional(),
    validated: z.boolean(),
  }).meta({
    ref: "CompactionRecoveryPart",
  })
  export type CompactionRecoveryPart = z.infer<typeof CompactionRecoveryPart>
  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  // While the LLM is streaming tool arguments (before the full JSON is parsed),
  // we emit "generating" with the accumulated raw JSON and its character length.
  // `input` is empty because arguments aren't fully parsed yet.
  export const ToolStateGenerating = z
    .object({
      status: z.literal("generating"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
      charsReceived: z.number(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({
      ref: "ToolStateGenerating",
    })

  export type ToolStateGenerating = z.infer<typeof ToolStateGenerating>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputTruncated: z.boolean().optional(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: AttachmentPart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [
      ToolStatePending,
      ToolStateGenerating,
      ToolStateRunning,
      ToolStateCompleted,
      ToolStateError,
    ])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  /**
   * Closed set of message origin types (issue #281 §4.2). Second-level
   * variation (e.g. blueprint loop_start vs loop_rejected) goes in `detail`,
   * never as a new top-level type. Unknown/legacy values decode to "system"
   * via `.catch` so stored data from older schemas still parses.
   */
  export const ORIGIN_TYPES = [
    "user", // direct user input (TUI / desktop / HTTP)
    "cortex", // background task / subagent completion
    "agenda", // scheduled or event-driven wake-up
    "blueprint", // BlueprintLoop control message
    "channel", // external channel (Feishu, etc.)
    "compaction", // compaction-injected continuation
    "agent", // cross-session delivery (session_send)
    "plugin", // plugin-delivered
    "system", // other internal mechanisms / fallback
  ] as const
  export type OriginType = (typeof ORIGIN_TYPES)[number]

  /** Origin types that render as a visible chip inside a turn. */
  export const RENDERED_ORIGIN_TYPES = new Set<OriginType>([
    "cortex",
    "agenda",
    "blueprint",
    "channel",
    "agent",
    "plugin",
  ])

  export const OriginUser = z
    .object({
      type: z.enum(ORIGIN_TYPES).catch("system"),
      sessionID: z.string().optional(),
      pluginID: z.string().optional(),
      label: z.string().optional(),
      detail: z.string().optional(),
    })
    .meta({ ref: "OriginUser" })
  export type OriginUser = z.infer<typeof OriginUser>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
    visible: z.boolean().optional(),
    includeInContext: z.boolean().optional(),
    rootID: z.string().optional(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    isRoot: z.boolean().optional(),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: SnapshotSchema.FileDiff.array(),
        diffState: z
          .discriminatedUnion("status", [
            z.object({ status: z.literal("pending"), deadlineAt: z.number() }),
            z.object({ status: z.literal("ready") }),
            z.object({
              status: z.literal("error"),
              code: z.enum(["timeout", "git_failure", "unknown"]),
            }),
          ])
          .optional(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
    origin: OriginUser.optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      ReasoningPart,
      AttachmentPart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      RetryPart,
      CompactionPart,
      CompactionRecoveryPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export function canonicalPart<T extends Part>(part: T): T {
    if (part.type !== "tool") return part
    if (part.state.status !== "completed") return part
    const bounded =
      part.state.outputTruncated && typeof part.state.outputBytes === "number"
        ? {
            output: part.state.output,
            outputBytes: part.state.outputBytes,
            outputTruncated: true,
          }
        : SessionBounds.toolOutput(part.state.output)
    return {
      ...part,
      state: {
        ...part.state,
        output: bounded.output,
        outputBytes: bounded.outputBytes,
        outputTruncated: bounded.outputTruncated || undefined,
        metadata: canonicalMetadata(part.state.metadata),
      },
      metadata: part.metadata ? canonicalMetadata(part.metadata) : part.metadata,
    } as T
  }

  export function canonicalMessage<T extends Info>(info: T): T {
    if (info.role !== "user" || !info.summary) return info
    const diffState = info.summary.diffState
    const expiredPending = diffState?.status === "pending" && diffState.deadlineAt <= Date.now()
    return {
      ...info,
      summary: {
        ...info.summary,
        diffs: SnapshotSchema.normalizeArray(info.summary.diffs) ?? [],
        ...(expiredPending ? { diffState: { status: "error" as const, code: "timeout" as const } } : {}),
      },
    } as T
  }

  function canonicalMetadata(metadata: Record<string, any>): Record<string, any> {
    const next = { ...metadata }
    const filediff = SnapshotSchema.normalize(next.filediff)
    if (filediff) next.filediff = filediff
    const results = Array.isArray(next.results)
      ? next.results.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item
          const result = { ...(item as Record<string, any>) }
          const resultDiff = SnapshotSchema.normalize(result.filediff)
          if (resultDiff) result.filediff = resultDiff
          return result
        })
      : undefined
    if (results) next.results = results
    return next
  }

  function modelProviderMetadata(metadata: Record<string, any> | undefined): Record<string, any> | undefined {
    if (!metadata) return undefined
    const openai = metadata.openai
    if (!openai || typeof openai !== "object" || Array.isArray(openai)) return metadata
    if (!("itemId" in openai) && !("reasoningEncryptedContent" in openai)) return metadata

    const nextOpenAI = { ...openai }
    delete nextOpenAI.itemId
    delete nextOpenAI.reasoningEncryptedContent

    const next = { ...metadata }
    if (Object.keys(nextOpenAI).length > 0) next.openai = nextOpenAI
    else delete next.openai

    return Object.keys(next).length > 0 ? next : undefined
  }

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    contextUsage: ContextUsageSchema.optional(),
    finish: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
      { streaming: true },
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  export function extractText(parts: Part[], options?: { includeSynthetic?: boolean; maxLength?: number }): string {
    const texts: string[] = []
    for (const part of parts) {
      if (part.type !== "text") continue
      if (!options?.includeSynthetic && isSystemPart(part)) continue
      texts.push(part.text)
    }
    const joined = texts.join("\n").trim()
    return options?.maxLength ? joined.slice(0, options.maxLength) : joined
  }

  export function isPromptVisible(msg: WithParts) {
    if (msg.info.includeInContext !== undefined) return msg.info.includeInContext
    return includeInContextFromMetadata(msg.info.metadata)
  }

  function includeInContextFromMetadata(metadata: Record<string, any> | undefined): boolean {
    if (metadata?.promptVisible === false) return false
    const command = metadata?.command
    if (command && typeof command === "object" && "promptVisible" in command && command.promptVisible === false)
      return false
    return true
  }

  // ── Read-time semantics derivation (issue #281 §12.2) ───────────────────
  //
  // The single place legacy metadata (synthetic / noReply / guided / source)
  // is interpreted. Applied once over the ordered message list at the read
  // boundary so every consumer — loop, compaction, frontend — reads only the
  // canonical fields (rootID / isRoot / visible / includeInContext / origin
  // and part.origin) and never the legacy heuristics.

  /**
   * Whether a part is system-injected rather than user-authored. Prefers the
   * canonical part.origin, falling back to the legacy `synthetic` flag for parts
   * that predate it. The single predicate all consumers should use instead of
   * reading `part.synthetic` directly.
   */
  export function isSystemPart(part: Part): boolean {
    if (part.type === "compaction") return true
    if (part.type !== "text") return false
    if (part.origin !== undefined) return part.origin === "system"
    return part.synthetic === true
  }

  function partIsSystem(part: Part): boolean {
    return isSystemPart(part)
  }

  function allPartsSystem(parts: Part[]): boolean {
    if (parts.length === 0) return true
    return parts.every(partIsSystem)
  }

  /**
   * Map legacy delivery metadata (source / sourceSessionID / channelPush …) to a
   * canonical origin. Shared by write-time (createUserMessage) and read-time
   * derivation so there is a single source of truth for the mapping (§4.2).
   */
  export function originFromMetadata(metadata: Record<string, any> | undefined): OriginUser {
    if (!metadata) return { type: "user" }
    const source = metadata.source
    const sessionID = typeof metadata.sourceSessionID === "string" ? metadata.sourceSessionID : undefined
    if (source === "cortex") return { type: "cortex", sessionID }
    if (source === "mailbox" || source === "agenda") return { type: "agenda", sessionID }
    if (typeof source === "string" && source.startsWith("blueprint_loop_"))
      return { type: "blueprint", detail: source.replace(/^blueprint_loop_/, "") }
    if (metadata.channelPush || metadata.mailbox) return { type: "channel" }
    if (sessionID?.trim()) return { type: "agent", sessionID }
    return { type: "user" }
  }

  /** Whether an origin renders as a visible chip when its message is non-root. */
  export function originRenders(origin: OriginUser): boolean {
    return RENDERED_ORIGIN_TYPES.has(origin.type)
  }

  // Origins that never own a loop: their messages are always injected into an
  // existing task, never a task root.
  const NON_ROOT_ORIGIN_TYPES = new Set<OriginType>(["cortex", "compaction", "system"])

  function deriveIsRoot(user: User, origin: OriginUser, parts: Part[]): boolean {
    const metadata = user.metadata
    if (metadata?.noReply === true) return false
    if (metadata?.guided === true) return false
    if (NON_ROOT_ORIGIN_TYPES.has(origin.type)) return false
    if (!includeInContextFromMetadata(metadata)) return false
    return !allPartsSystem(parts)
  }

  function deriveVisible(user: User, origin: OriginUser, parts: Part[]): boolean {
    const synthetic = user.metadata?.synthetic === true || allPartsSystem(parts)
    if (!synthetic) return true
    return RENDERED_ORIGIN_TYPES.has(origin.type)
  }

  function deriveParts(parts: Part[]): Part[] {
    let changed = false
    const next = parts.map((part) => {
      if (part.type !== "text" || part.origin !== undefined) return part
      changed = true
      return { ...part, origin: part.synthetic ? ("system" as const) : ("user" as const) }
    })
    return changed ? next : parts
  }

  /**
   * Populate canonical semantic fields for any message that predates them.
   * Idempotent: messages already carrying the fields pass through untouched
   * (only their running rootID is tracked so later assistants inherit it).
   */
  export function deriveSemantics(messages: WithParts[]): WithParts[] {
    let rootID: string | undefined
    return messages.map((msg) => {
      const parts = deriveParts(msg.parts)
      if (msg.info.role === "user") {
        const user = msg.info as User
        const origin = user.origin ?? originFromMetadata(user.metadata)
        const isRoot = user.isRoot ?? deriveIsRoot(user, origin, parts)
        const resolvedRoot = user.rootID ?? (isRoot ? user.id : (rootID ?? user.id))
        if (isRoot) rootID = resolvedRoot
        else if (rootID === undefined) rootID = resolvedRoot
        const info: User = {
          ...user,
          isRoot,
          rootID: resolvedRoot,
          origin,
          visible: user.visible ?? deriveVisible(user, origin, parts),
          includeInContext: user.includeInContext ?? includeInContextFromMetadata(user.metadata),
        }
        return parts === msg.parts && info === msg.info ? msg : { info, parts }
      }
      const assistant = msg.info as Assistant
      const resolvedRoot = assistant.rootID ?? rootID ?? assistant.parentID
      const info: Assistant = { ...assistant, rootID: resolvedRoot }
      return { info, parts }
    })
  }

  function attachmentName(part: AttachmentPart): string {
    if (part.filename) return part.filename
    if (part.localPath) return path.basename(part.localPath)
    return "unnamed attachment"
  }

  function attachmentSummary(part: AttachmentPart): string {
    const model = part.model
    if (model?.mode === "summary" || model?.mode === "provider-file") {
      if (model.summary?.trim()) return model.summary.trim()
    }
    if (part.localPath) return `${attachmentName(part)} (${part.mime}) at ${part.localPath}`
    return `${attachmentName(part)} (${part.mime})`
  }

  function attachmentModelMode(part: AttachmentPart): AttachmentModelPolicy["mode"] {
    return part.model?.mode ?? "summary"
  }

  function shouldSendAttachmentFile(part: AttachmentPart): boolean {
    if (attachmentModelMode(part) !== "provider-file") return false
    if (part.url.startsWith("asset://")) return false
    return part.mime !== "application/x-directory"
  }

  function shouldExternalizeAttachment(part: AttachmentPart): boolean {
    if (!part.url.startsWith("data:")) return false
    if (attachmentModelMode(part) === "provider-file") return false
    return true
  }

  async function externalizeAttachment(part: AttachmentPart): Promise<AttachmentPart> {
    if (!shouldExternalizeAttachment(part)) return part
    const decoded = Attachment.decodeDataUrl(part.url)
    const assetID = await Asset.write(decoded.buffer, part.mime, part.filename)
    const attachmentMetadata =
      part.metadata?.attachment &&
      typeof part.metadata.attachment === "object" &&
      !Array.isArray(part.metadata.attachment)
        ? part.metadata.attachment
        : {}
    return {
      ...part,
      url: `asset://${assetID}`,
      metadata: {
        ...part.metadata,
        attachment: {
          ...attachmentMetadata,
          size: decoded.buffer.length,
        },
      },
    }
  }

  async function externalizePart(part: Part): Promise<{ part: Part; changed: boolean }> {
    if (part.type === "attachment") {
      const next = await externalizeAttachment(part)
      return { part: next, changed: next !== part }
    }
    if (part.type !== "tool" || part.state.status !== "completed" || !part.state.attachments?.length) {
      return { part, changed: false }
    }
    let changed = false
    const attachments = await Promise.all(
      part.state.attachments.map(async (attachment) => {
        const next = await externalizeAttachment(attachment)
        if (next !== attachment) changed = true
        return next
      }),
    )
    if (!changed) return { part, changed: false }
    return {
      part: {
        ...part,
        state: {
          ...part.state,
          attachments,
        },
      },
      changed: true,
    }
  }

  function attachmentHash(part: AttachmentPart): string {
    return new Bun.CryptoHasher("sha256").update(part.url).digest("hex").slice(0, 16)
  }

  export interface ModelMessageContribution {
    text: string
  }

  export interface ModelMessageProvenance {
    categories: {
      conversation: ModelMessageContribution[]
      toolActivity: ModelMessageContribution[]
      filesReferences: ModelMessageContribution[]
      instructions: ModelMessageContribution[]
    }
    items: {
      conversation: number
      toolActivity: number
      filesReferences: number
      instructions: number
    }
  }

  function createModelMessageProvenance(): ModelMessageProvenance {
    return {
      categories: {
        conversation: [],
        toolActivity: [],
        filesReferences: [],
        instructions: [],
      },
      items: {
        conversation: 0,
        toolActivity: 0,
        filesReferences: 0,
        instructions: 0,
      },
    }
  }

  function addModelMessageContribution(
    provenance: ModelMessageProvenance,
    category: keyof ModelMessageProvenance["categories"],
    text: string | undefined,
  ) {
    if (!text) return
    provenance.categories[category].push({ text })
    provenance.items[category]++
  }

  function appendAttachmentModelParts(
    parts: UIMessage["parts"],
    part: AttachmentPart,
    provenance: ModelMessageProvenance,
    options: { keptHashes?: Set<string>; includeLocalPath?: boolean } = {},
  ) {
    const mode = attachmentModelMode(part)
    if (mode === "none") return
    provenance.items.filesReferences++

    if (mode === "content") {
      const content = part.model?.mode === "content" ? part.model.text : undefined
      const text = content?.trim() ? content : `[Attachment content: ${attachmentSummary(part)}]`
      parts.push({ type: "text", text })
      provenance.categories.filesReferences.push({ text })
      return
    }

    if (!shouldSendAttachmentFile(part)) {
      const text = `[Attachment: ${attachmentSummary(part)}]`
      parts.push({ type: "text", text })
      provenance.categories.filesReferences.push({ text })
      return
    }

    if (options.includeLocalPath && part.localPath) {
      const text = `[The user attached a file: ${attachmentName(part)} (${part.mime}). Local path: ${part.localPath}]`
      parts.push({ type: "text", text })
      provenance.categories.filesReferences.push({ text })
    }

    const keptHashes = options.keptHashes
    if (keptHashes && !Attachment.isText(part.mime)) {
      const hash = attachmentHash(part)
      if (!keptHashes.has(hash)) {
        const text = `[Image: ${attachmentName(part)} — previously shared]`
        parts.push({ type: "text", text })
        provenance.categories.filesReferences.push({ text })
        return
      }
    }

    parts.push({
      type: "file",
      url: part.url,
      mediaType: part.mime,
      filename: part.filename,
    })
  }

  function isTerminalToolPart(part: Part): part is ToolPart {
    return part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")
  }

  function isAISDKToolError(part: ToolPart) {
    return (
      part.state.status === "error" && part.state.metadata?.toolDiagnostic?.metadata?.source === "ai_sdk_tool_error"
    )
  }

  function canonicalTerminalToolParts(parts: Part[]) {
    const canonical = new Map<string, ToolPart>()
    for (const part of parts) {
      if (!isTerminalToolPart(part)) continue
      const existing = canonical.get(part.callID)
      if (!existing || (isAISDKToolError(existing) && !isAISDKToolError(part))) {
        canonical.set(part.callID, part)
      }
    }
    return new Set(canonical.values())
  }

  export function projectModelMessages(
    input: WithParts[],
    opts?: { maxHistoryImages?: number },
  ): { messages: ModelMessage[]; provenance: ModelMessageProvenance } {
    // Pass 1: collect unique image hashes in order of first appearance
    const imageHashSet = new Set<string>()
    const orderedHashes: string[] = []
    for (const msg of input) {
      if (msg.info.role !== "user" || !isPromptVisible(msg)) continue
      for (const part of msg.parts) {
        if (part.type !== "attachment") continue
        if (!shouldSendAttachmentFile(part)) continue
        if (Attachment.isText(part.mime) || part.mime === "application/x-directory") continue
        const hash = attachmentHash(part)
        if (!imageHashSet.has(hash)) {
          imageHashSet.add(hash)
          orderedHashes.push(hash)
        }
      }
    }

    let keptHashes: Set<string>
    if (opts?.maxHistoryImages !== undefined) {
      const keepCount = Math.max(0, opts.maxHistoryImages)
      if (keepCount === 0) {
        keptHashes = new Set()
      } else {
        const kept = orderedHashes.slice(-keepCount)
        keptHashes = new Set(kept)
      }
    } else {
      keptHashes = imageHashSet
    }

    const result: UIMessage[] = []
    const provenance = createModelMessageProvenance()

    for (const msg of input) {
      if (msg.parts.length === 0 || !isPromptVisible(msg)) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          // part.origin has no effect on model visibility (spec §4.4):
          // system-injected text is meant for the model too.
          if (part.type === "text") {
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
            addModelMessageContribution(provenance, isSystemPart(part) ? "instructions" : "conversation", part.text)
          }
          if (part.type === "attachment") {
            appendAttachmentModelParts(userMessage.parts, part, provenance, { keptHashes, includeLocalPath: true })
          }
        }
      }

      if (msg.info.role === "assistant") {
        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        const canonicalToolParts = canonicalTerminalToolParts(msg.parts)
        for (const part of msg.parts) {
          if (part.type === "text") {
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              providerMetadata: modelProviderMetadata(part.metadata),
            })
            addModelMessageContribution(provenance, "conversation", part.text)
          }
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            if (isTerminalToolPart(part) && !canonicalToolParts.has(part)) continue
            if (part.state.status === "completed") {
              if (part.state.attachments?.length) {
                const attachmentIntroduction = `Tool ${part.tool} returned attachment results:`
                const attachmentParts: UIMessage["parts"] = [
                  {
                    type: "text",
                    text: attachmentIntroduction,
                  },
                ]
                for (const attachment of part.state.attachments) {
                  appendAttachmentModelParts(attachmentParts, attachment, provenance)
                }
                if (attachmentParts.length > 1) {
                  result.push({
                    id: Identifier.ascending("message"),
                    role: "user",
                    parts: attachmentParts,
                  })
                  addModelMessageContribution(provenance, "toolActivity", attachmentIntroduction)
                }
              }
              const output = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                callProviderMetadata: modelProviderMetadata(part.metadata),
              })
              addModelMessageContribution(provenance, "toolActivity", JSON.stringify(part.state.input))
              addModelMessageContribution(provenance, "toolActivity", output)
            }
            if (part.state.status === "error") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                callProviderMetadata: modelProviderMetadata(part.metadata),
              })
              addModelMessageContribution(provenance, "toolActivity", JSON.stringify(part.state.input))
              addModelMessageContribution(provenance, "toolActivity", part.state.error)
            }
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              providerMetadata: modelProviderMetadata(part.metadata),
            })
            addModelMessageContribution(provenance, "conversation", part.text)
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    return {
      messages: convertToModelMessages(result.filter((msg) => msg.parts.some((part) => part.type !== "step-start"))),
      provenance,
    }
  }

  export function toModelMessage(input: WithParts[], opts?: { maxHistoryImages?: number }): ModelMessage[] {
    return projectModelMessages(input, opts).messages
  }

  function isLegacyStableDeliveryMessageID(id: string): boolean {
    return /^msg_[0-9a-f]{26}$/.test(id)
  }

  export function compareStorageOrder(a: Info, b: Info): number {
    if (isLegacyStableDeliveryMessageID(a.id) || isLegacyStableDeliveryMessageID(b.id)) {
      const created = a.time.created - b.time.created
      if (created !== 0) return created
    }
    return a.id.localeCompare(b.id)
  }

  export const stream = fn(
    z.object({
      scopeID: z.string().optional(),
      sessionID: Identifier.schema("session"),
    }),
    async function* (input) {
      const session = input.scopeID ? undefined : await requireSession(input.sessionID)
      const scopeID = Identifier.asScopeID(input.scopeID ?? (session!.scope as Scope).id)
      const sessionID = input.sessionID as Identifier.SessionID
      const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sessionID))
      const readMessage = (messageID: string) =>
        get({
          scopeID,
          sessionID: input.sessionID,
          messageID,
        })

      if (!messageIDs.some(isLegacyStableDeliveryMessageID)) {
        for (let index = messageIDs.length - 1; index >= 0; index--) {
          const messageID = messageIDs[index]
          try {
            yield await readMessage(messageID)
          } catch (error) {
            log.warn("skipping unreadable message", { sessionID: input.sessionID, messageID, error: String(error) })
          }
        }
        return
      }

      const infos = await Storage.readMany<MessageV2.Info>(
        messageIDs.map((messageID) => StoragePath.messageInfo(scopeID, sessionID, messageID as Identifier.MessageID)),
      )
      const ordered = infos
        .filter((info): info is MessageV2.Info => info !== undefined)
        .map(canonicalMessage)
        .sort((a, b) => compareStorageOrder(b, a))

      for (const info of ordered) {
        try {
          yield {
            info,
            parts: await parts({ scopeID, sessionID: input.sessionID, messageID: info.id }),
          }
        } catch (error) {
          log.warn("skipping unreadable message", {
            sessionID: input.sessionID,
            messageID: info.id,
            error: String(error),
          })
        }
      }
    },
  )

  export const parts = fn(
    z.object({
      scopeID: z.string().optional(),
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      const session = input.scopeID ? undefined : await requireSession(input.sessionID)
      const scopeID = Identifier.asScopeID(input.scopeID ?? (session!.scope as Scope).id)
      const sessionID = input.sessionID as Identifier.SessionID
      const messageID = input.messageID as Identifier.MessageID
      const partIDs = await Storage.scan(StoragePath.messageParts(scopeID, sessionID, messageID))
      const keys = partIDs.map((id) => StoragePath.messagePart(scopeID, sessionID, messageID, id as Identifier.PartID))
      const results = await Storage.readMany<MessageV2.Part>(keys)
      const parts = await Promise.all(
        results
          .filter((p): p is MessageV2.Part => p !== undefined)
          .map(async (part) => {
            const externalized = await externalizePart(part)
            if (externalized.changed) {
              await Storage.write(
                StoragePath.messagePart(scopeID, sessionID, messageID, externalized.part.id as Identifier.PartID),
                externalized.part,
              )
            }
            return externalized.part
          }),
      )
      parts.sort((a, b) => (a.id > b.id ? 1 : -1))
      return parts.map((part) => {
        if (part.type === "tool" && part.state.status === "completed" && part.state.time.compacted) {
          return {
            ...part,
            state: {
              ...part.state,
              output: "",
            },
          }
        }
        return part
      })
    },
  )

  export const get = fn(
    z.object({
      scopeID: z.string().optional(),
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      const session = input.scopeID ? undefined : await requireSession(input.sessionID)
      const scopeID = Identifier.asScopeID(input.scopeID ?? (session!.scope as Scope).id)
      const sessionID = input.sessionID as Identifier.SessionID
      const messageID = input.messageID as Identifier.MessageID
      const info = canonicalMessage(
        await Storage.read<MessageV2.Info>(StoragePath.messageInfo(scopeID, sessionID, messageID)),
      )
      return {
        info,
        parts: await parts({ scopeID, sessionID: input.sessionID, messageID: input.messageID }),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const skipped = [] as MessageV2.WithParts[]
    let boundaryUserID: string | undefined
    let foundBoundary = false
    for await (const msg of stream) {
      if (!boundaryUserID) {
        result.push(msg)
        if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) boundaryUserID = msg.info.parentID
        continue
      }

      if (
        msg.info.role !== "user" ||
        msg.info.id !== boundaryUserID ||
        !msg.parts.some((part) => part.type === "compaction")
      ) {
        skipped.push(msg)
        continue
      }

      const boundaryID = boundaryUserID
      result.push(
        ...skipped
          .filter((item) => isFulfilledCompactionSummary(item, boundaryID))
          .map((item) => ({ ...item, info: { ...item.info, includeInContext: false } })),
      )
      result.push(msg)
      foundBoundary = true
      break
    }
    if (boundaryUserID && !foundBoundary) result.push(...skipped)
    result.reverse()
    return result
  }

  function isFulfilledCompactionSummary(msg: MessageV2.WithParts, parentID: string): boolean {
    if (msg.info.role !== "assistant") return false
    const assistant = msg.info as MessageV2.Assistant
    return assistant.parentID === parentID && assistant.summary === true && !!assistant.finish
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case e instanceof DOMException && e.name === "TimeoutError":
        return new MessageV2.APIError(
          {
            message: e.message || "Idle timeout: no data received from provider",
            isRetryable: true,
          },
          { cause: e },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case ProviderAuthRecoveryError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: e.data.providerID,
            message: e.data.message,
            failureCode: e.data.failureCode,
            actionRequired: e.data.actionRequired,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case isRetryableNetworkError(e):
        return new MessageV2.APIError(
          {
            message: (e as Error).message,
            isRetryable: true,
            metadata: networkErrorMetadata(e as Error),
          },
          { cause: e },
        ).toObject()
      case e instanceof Error &&
        typeof (e as SystemError).message === "string" &&
        isTLSError((e as SystemError).message):
        return new MessageV2.APIError(
          {
            message: (e as SystemError).message,
            isRetryable: true,
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const message = iife(() => {
          let msg = e.message
          if (msg === "") {
            if (e.responseBody) return e.responseBody
            if (e.statusCode) {
              const err = STATUS_CODES[e.statusCode]
              if (err) return err
            }
            return "Unknown error"
          }
          const transformed = ProviderTransform.error(ctx.providerID, e)
          if (transformed !== msg) {
            return transformed
          }
          if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
            return msg
          }

          try {
            const body = JSON.parse(e.responseBody)
            // try to extract common error message fields
            const errMsg = body.message || body.error || body.error?.message
            if (errMsg && typeof errMsg === "string") {
              return `${msg}: ${errMsg}`
            }
          } catch {}

          return `${msg}: ${e.responseBody}`
        }).trim()
        const cause = (e as Error & { cause?: unknown }).cause

        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: e.isRetryable || retryableNetworkMessage(message) || isRetryableNetworkError(cause),
            responseHeaders: e.responseHeaders,
            responseBody: e.responseBody,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e })
    }
  }
}
