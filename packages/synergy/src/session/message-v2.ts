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
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { type SystemError } from "bun"
import type { Scope } from "@/scope"
import { Attachment } from "@/attachment"
import { Log } from "@/util/log"
import { SessionBounds } from "./bounds"

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
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
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

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: SnapshotSchema.FileDiff.array(),
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
    if (info.role !== "user" || !info.summary?.diffs) return info
    return {
      ...info,
      summary: {
        ...info.summary,
        diffs: SnapshotSchema.normalizeArray(info.summary.diffs) ?? [],
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

  export function extractText(
    parts: Part[],
    options?: { includeSynthetic?: boolean; includeIgnored?: boolean; maxLength?: number },
  ): string {
    const texts: string[] = []
    for (const part of parts) {
      if (part.type !== "text") continue
      if (!options?.includeIgnored && part.ignored) continue
      if (!options?.includeSynthetic && part.synthetic) continue
      texts.push(part.text)
    }
    const joined = texts.join("\n").trim()
    return options?.maxLength ? joined.slice(0, options.maxLength) : joined
  }

  export function isPromptVisible(msg: WithParts) {
    const metadata = msg.info.metadata
    if (metadata?.promptVisible === false) return false
    const command = metadata?.command
    if (command && typeof command === "object" && "promptVisible" in command && command.promptVisible === false)
      return false
    return true
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

  function attachmentHash(part: AttachmentPart): string {
    return new Bun.CryptoHasher("sha256").update(part.url).digest("hex").slice(0, 16)
  }

  function appendAttachmentModelParts(
    parts: UIMessage["parts"],
    part: AttachmentPart,
    options: { keptHashes?: Set<string>; includeLocalPath?: boolean } = {},
  ) {
    const mode = attachmentModelMode(part)
    if (mode === "none") return

    if (mode === "content") {
      const text = part.model?.mode === "content" ? part.model.text : undefined
      parts.push({
        type: "text",
        text: text?.trim() ? text : `[Attachment content: ${attachmentSummary(part)}]`,
      })
      return
    }

    if (!shouldSendAttachmentFile(part)) {
      parts.push({
        type: "text",
        text: `[Attachment: ${attachmentSummary(part)}]`,
      })
      return
    }

    if (options.includeLocalPath && part.localPath) {
      parts.push({
        type: "text",
        text: `[The user attached a file: ${attachmentName(part)} (${part.mime}). Local path: ${part.localPath}]`,
      })
    }

    const keptHashes = options.keptHashes
    if (keptHashes && !Attachment.isText(part.mime)) {
      const hash = attachmentHash(part)
      if (!keptHashes.has(hash)) {
        parts.push({
          type: "text",
          text: `[Image: ${attachmentName(part)} — previously shared]`,
        })
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

  export function toModelMessage(input: WithParts[], opts?: { maxHistoryImages?: number }): ModelMessage[] {
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
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          if (part.type === "attachment") {
            appendAttachmentModelParts(userMessage.parts, part, { keptHashes, includeLocalPath: true })
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
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              providerMetadata: modelProviderMetadata(part.metadata),
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            if (part.state.status === "completed") {
              if (part.state.attachments?.length) {
                const attachmentParts: UIMessage["parts"] = [
                  {
                    type: "text",
                    text: `Tool ${part.tool} returned attachment results:`,
                  },
                ]
                for (const attachment of part.state.attachments) {
                  appendAttachmentModelParts(attachmentParts, attachment)
                }
                if (attachmentParts.length > 1)
                  result.push({
                    id: Identifier.ascending("message"),
                    role: "user",
                    parts: attachmentParts,
                  })
              }
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output: part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output,
                callProviderMetadata: modelProviderMetadata(part.metadata),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                callProviderMetadata: modelProviderMetadata(part.metadata),
              })
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              providerMetadata: modelProviderMetadata(part.metadata),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    return convertToModelMessages(result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")))
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
      for (let i = messageIDs.length - 1; i >= 0; i--) {
        const messageID = messageIDs[i]
        try {
          yield await get({
            scopeID: scopeID,
            sessionID: input.sessionID,
            messageID,
          })
        } catch (error) {
          log.warn("skipping unreadable message", { sessionID: input.sessionID, messageID, error: String(error) })
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
      const parts = results.filter((p): p is MessageV2.Part => p !== undefined)
      parts.sort((a, b) => (a.id > b.id ? 1 : -1))
      for (const part of parts) {
        if (part.type === "tool" && part.state.status === "completed" && part.state.time.compacted) {
          part.state.output = ""
        }
      }
      return parts
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
      return {
        info: await Storage.read<MessageV2.Info>(StoragePath.messageInfo(scopeID, sessionID, messageID)),
        parts: await parts({ scopeID, sessionID: input.sessionID, messageID: input.messageID }),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
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
