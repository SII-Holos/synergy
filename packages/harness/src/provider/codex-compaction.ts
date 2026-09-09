/**
 * Codex Remote Compaction V2 (private protocol) helpers.
 *
 * Mirrors how the Codex CLI requests server-side compaction from the
 * `chatgpt.com/backend-api/codex` Responses endpoint: a normal streaming
 * `/responses` request whose `input` array ends with a `compaction_trigger`
 * item and whose headers carry `x-codex-beta-features: remote_compaction_v2`.
 *
 * The returned opaque `compaction` item is persisted (see session compaction
 * metadata) and replayed on later same-model turns by splicing the stored
 * replacement history into the serialized request body at the codex fetch
 * layer. This module is intentionally free of session/storage imports so it
 * stays unit-testable and safe to use from the worker process.
 *
 * Item shapes follow the wire format the Responses API actually accepts and
 * that `@ai-sdk/openai` emits: role-based message items
 * (`{role, content}` with string or part-array content, no `type` tag) plus
 * type-tagged non-message items (`function_call`, `function_call_output`,
 * `reasoning`, `compaction`, `compaction_trigger`).
 */

/**
 * Worker-safe canonical provider identifier for codex remote compaction.
 * Lives in this dependency-free helper module so the LLM worker graph can
 * compare provider IDs without value-importing the full Codex provider module
 * (auth, global filesystem, recovery). The provider module aliases it as its
 * public `PROVIDER_ID` so the two can never drift.
 */
export const CODEX_PROVIDER_ID = "openai-codex"

const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2"
const RETAINED_MESSAGE_TOKEN_BUDGET = 20_000

export type CodexMessageRole = "user" | "assistant" | "developer" | "system"

export type CodexResponseContentItem =
  | { type: "input_text"; text: string; [key: string]: unknown }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string; [key: string]: unknown }
  | { type: "input_file"; file_url?: string; file_data?: string; filename?: string; [key: string]: unknown }
  | { type: "output_text"; text: string; [key: string]: unknown }
  | { type: "summary_text"; text: string; [key: string]: unknown }
  | { type: "refusal"; refusal?: string; [key: string]: unknown }
  | (Record<string, unknown> & { type: string })

/** Role-based message item: the shape the SDK serializes for `input`. */
export type CodexRoleMessageItem = {
  role: CodexMessageRole
  content: string | CodexResponseContentItem[]
  [key: string]: unknown
}

export type CodexResponseItem =
  | CodexRoleMessageItem
  | {
      type: "reasoning"
      summary?: CodexResponseContentItem[]
      encrypted_content?: string | null
      [key: string]: unknown
    }
  | {
      type: "function_call"
      name: string
      arguments: string
      call_id: string
      [key: string]: unknown
    }
  | { type: "function_call_output"; call_id: string; output: unknown; [key: string]: unknown }
  | { type: "compaction"; encrypted_content: string; [key: string]: unknown }
  | { type: "compaction_trigger" }

export type CodexResponseMessageItem = CodexRoleMessageItem

export type CodexRemoteCompactionUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  [key: string]: unknown
}

export type CodexRemoteCompactionMetadata = {
  version: 2
  provider: "openai-responses-compaction"
  implementation: "responses_compaction_v2"
  modelKey: string
  providerID: string
  /** Conversation-model catalog key that produced the artifact. */
  modelID: string
  /** Resolved wire model id actually sent to the Responses endpoint. */
  apiModelID?: string
  summaryText: string
  replacementHistory: CodexResponseItem[]
  usage?: CodexRemoteCompactionUsage
}

/** Replay plan handed to the codex fetch layer for one turn. */
export type CodexReplayPlan = {
  /** Replacement history: retained user messages + opaque compaction item. */
  replacementHistory: CodexResponseItem[]
  /** Exact summary text stored at compaction, used to locate the region to replace. */
  summaryText: string
}

/**
 * Minimal structural view of a language-model prompt message (the shape ai
 * produces for `messages` and the SDK serializes into Responses input items).
 * Kept local so this module stays free of `ai` type dependencies; runtime
 * shape checks mirror the SDK's serialization rules.
 */
export type CodexModelMessageLike = {
  role?: unknown
  content?: unknown
  providerOptions?: unknown
}

export type CodexModelPartLike = {
  type?: unknown
  text?: unknown
  toolCallId?: unknown
  toolName?: unknown
  input?: unknown
  output?: unknown
  mediaType?: unknown
  data?: unknown
  filename?: unknown
  providerOptions?: unknown
}

const MESSAGE_ROLES = new Set<CodexMessageRole>(["user", "assistant", "developer", "system"])
const KNOWN_NON_MESSAGE_TYPES = new Set([
  "reasoning",
  "function_call",
  "function_call_output",
  "compaction",
  "compaction_trigger",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isContentPart(value: unknown): value is CodexResponseContentItem {
  if (!isRecord(value)) return false
  return typeof value.type === "string" && value.type.length > 0
}

function validMessageContent(value: unknown): boolean {
  if (typeof value === "string") return true
  if (!Array.isArray(value)) return false
  return value.every((part) => isContentPart(part))
}

/** Structural validator for values read back from persisted metadata. */
export function isCodexResponseItem(value: unknown): value is CodexResponseItem {
  if (!isRecord(value)) return false
  if ("type" in value) {
    const type = value.type
    if (typeof type !== "string" || !KNOWN_NON_MESSAGE_TYPES.has(type)) return false
    if (type === "reasoning") {
      return value.summary === undefined || Array.isArray(value.summary)
    }
    if (type === "function_call") return typeof value.name === "string" && typeof value.call_id === "string"
    if (type === "function_call_output") return typeof value.call_id === "string"
    if (type === "compaction") return typeof value.encrypted_content === "string"
    return true // compaction_trigger
  }
  return isCodexMessageItem(value)
}

export function isCodexMessageItem(value: unknown): value is CodexRoleMessageItem {
  if (!isRecord(value)) return false
  const role = value.role
  return typeof role === "string" && MESSAGE_ROLES.has(role as CodexMessageRole) && validMessageContent(value.content)
}

export function codexMessageRole(item: CodexResponseItem): CodexMessageRole | undefined {
  if (!("role" in item)) return undefined
  const role = item.role
  return MESSAGE_ROLES.has(role as CodexMessageRole) ? (role as CodexMessageRole) : undefined
}

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

/** Estimate tokens for the retained-user-message budget (4 chars/token). */
function approximateItemTokens(item: CodexResponseItem): number {
  if (!isCodexMessageItem(item)) return 1
  if (typeof item.content === "string") return Math.max(1, Math.ceil(item.content.length / 4))
  let chars = 0
  for (const part of item.content) {
    if ("text" in part && typeof part.text === "string") chars += part.text.length
    if ("image_url" in part && typeof part.image_url === "string") chars += 200
  }
  return Math.max(1, Math.ceil(chars / 4))
}

function isRealUserMessage(item: CodexResponseItem): boolean {
  if (!isCodexMessageItem(item) || item.role !== "user") return false
  if (typeof item.content === "string") return item.content.trim().length > 0
  return item.content.some(
    (part) => part.type === "input_text" && typeof part.text === "string" && part.text.trim().length > 0,
  )
}

function cloneItem<T extends CodexResponseItem>(item: T): T {
  return JSON.parse(JSON.stringify(item)) as T
}

function truncateItemToBudget(item: CodexResponseItem, remainingTokens: number): CodexResponseItem | undefined {
  if (!isCodexMessageItem(item)) return cloneItem(item)
  if (typeof item.content === "string") {
    const text = item.content.slice(0, Math.max(0, Math.floor(remainingTokens * 4)))
    return text.length > 0 ? { ...cloneItem(item), content: text } : undefined
  }
  const content: CodexResponseContentItem[] = []
  let remainingChars = Math.max(0, Math.floor(remainingTokens * 4))
  for (const part of item.content) {
    if (remainingChars === 0) break
    if (part.type === "input_image") {
      content.push(part)
      remainingChars -= 200
      continue
    }
    if (part.type === "input_text") {
      const raw = (part as { text?: unknown }).text
      const source = typeof raw === "string" ? raw : ""
      const text = source.slice(0, remainingChars)
      remainingChars -= text.length
      if (text.length > 0) content.push({ ...part, text })
      continue
    }
    content.push(part)
  }
  return content.length > 0 ? { ...cloneItem(item), content } : undefined
}

/**
 * Build the persisted replacement history shape used by Codex-style replay:
 * retained conversation items (newest real user messages within the token
 * budget, plus every prior opaque compaction item — the backend-state anchor
 * for repeated compactions) followed by the new compaction item. The
 * compaction items are never truncated or rewritten; when the budget does
 * not fit them they still win and older retained messages are dropped first.
 */
export function buildReplacementHistory(
  input: CodexResponseItem[],
  compactionItem: CodexResponseItem,
): CodexResponseItem[] {
  if (compactionItem.type !== "compaction") {
    throw new Error("Codex remote compaction v2 did not return a compaction item.")
  }
  // Walk newest-first. Prior opaque compaction items are always retained
  // (dropping them would make the next compaction/artifact restart from the
  // lossy local summary); real user messages are retained newest-first within
  // the budget.
  const kept: CodexResponseItem[] = []
  let remaining = RETAINED_MESSAGE_TOKEN_BUDGET
  for (const item of [...input].reverse()) {
    if (!isCodexMessageItem(item) && "type" in item && item.type === "compaction") {
      kept.push(cloneItem(item))
      continue
    }
    if (!isRealUserMessage(item)) continue
    if (remaining <= 0) break
    const cost = approximateItemTokens(item)
    if (cost <= remaining) {
      kept.push(cloneItem(item))
      remaining -= cost
      continue
    }
    const truncated = truncateItemToBudget(item, remaining)
    if (truncated) kept.push(truncated)
    remaining = 0
  }
  return [...kept.reverse(), cloneItem(compactionItem)]
}

/**
 * Parse the SSE event stream of a remote compaction response. Strict: exactly
 * one `compaction` output item must appear and the response must complete.
 */
export function parseRemoteCompactionEvents(events: unknown[]): {
  compactionItem: CodexResponseItem
  usage?: unknown
} {
  let completed = false
  let usage: unknown
  const compactionItems: CodexResponseItem[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue
    const event = raw as {
      type?: unknown
      message?: unknown
      response?: { error?: { message?: string }; usage?: unknown }
    }
    if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : "Unknown Responses API error"
      throw new Error(`Codex remote compaction v2 failed: ${message}`)
    }
    if (event.type === "response.failed") {
      const error = event.response?.error
      const message = typeof error?.message === "string" ? error.message : "Response failed"
      throw new Error(`Codex remote compaction v2 failed: ${message}`)
    }
    if (event.type === "response.output_item.done") {
      const item = (event as { item?: unknown }).item
      if (isCodexResponseItem(item) && item.type === "compaction") compactionItems.push(item)
      continue
    }
    if (event.type === "response.completed") {
      completed = true
      usage = event.response?.usage
    }
  }
  if (!completed) {
    throw new Error("Codex remote compaction v2 stream ended before response.completed.")
  }
  if (compactionItems.length !== 1) {
    throw new Error(`Codex remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}.`)
  }
  return { compactionItem: compactionItems[0], usage }
}

export const REMOTE_COMPACTION_MAX_EVENT_BYTES = 16 * 1024 * 1024

/**
 * Pull-based, per-event-bounded reader over an SSE byte stream. Decodes the
 * stream incrementally, splits on blank-line event boundaries (`\n\n` and
 * `\r\n\r\n`), and yields one parsed JSON payload per `data:` block (skipping
 * `[DONE]`). A single event larger than `maxEventBytes` cancels the stream and
 * throws; the underlying reader is released on every terminal path
 * (completion, error, caller abort).
 */
export async function* readSseJsonEvents(
  stream: ReadableStream<Uint8Array>,
  opts?: { signal?: AbortSignal; maxEventBytes?: number },
): AsyncGenerator<unknown> {
  const maxEventBytes = opts?.maxEventBytes ?? REMOTE_COMPACTION_MAX_EVENT_BYTES
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let readerReleased = false
  const release = () => {
    if (readerReleased) return
    readerReleased = true
    try {
      reader.releaseLock()
    } catch {}
  }
  const cancel = async (error?: unknown) => {
    try {
      await reader.cancel(error)
    } catch {
      // The stream may already be errored or cancelled by the producer.
    } finally {
      release()
    }
  }
  // Race the pull against the caller signal so an abort interrupts a read
  // that never delivers (the same pattern as ProviderStream.readWithAbort).
  const readWithAbort = async () => {
    opts?.signal?.throwIfAborted()
    if (!opts?.signal) return reader.read()
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(opts.signal!.reason ?? new DOMException("Aborted", "AbortError"))
      opts.signal!.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([reader.read(), aborted])
    } finally {
      if (onAbort) opts.signal!.removeEventListener("abort", onAbort)
    }
  }
  const parseBlock = (block: string): unknown | undefined => {
    if (block.length > maxEventBytes) {
      void cancel(new Error(`Codex SSE event exceeded the ${maxEventBytes}-byte bound`))
      throw new Error(`Codex SSE event exceeded the ${maxEventBytes}-byte bound`)
    }
    const data = block
      .split("\n")
      // Mixed line endings: strip a trailing \r per line so a \n\n boundary
      // inside a CRLF stream still yields clean data lines.
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data || data === "[DONE]") return undefined
    try {
      return JSON.parse(data) as unknown
    } catch {
      // Tolerate a malformed keep-alive/comment block like the text parser.
      return undefined
    }
  }
  try {
    while (true) {
      const { done, value } = await readWithAbort()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const lf = buffer.indexOf("\n\n")
        const crlf = buffer.indexOf("\r\n\r\n")
        if (lf === -1 && crlf === -1) break
        const isCrlf = crlf !== -1 && (lf === -1 || crlf < lf)
        const boundary = isCrlf ? crlf : lf
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + (isCrlf ? 4 : 2))
        const event = parseBlock(block)
        if (event !== undefined) yield event
      }
      // Every complete event has been consumed, so the remainder is a single
      // partial event; bound it so a misbehaving upstream cannot grow memory
      // between boundaries (the per-event bound only fires on full events).
      if (buffer.length > maxEventBytes) {
        void cancel(new Error(`Codex SSE event exceeded the ${maxEventBytes}-byte bound`))
        throw new Error(`Codex SSE event exceeded the ${maxEventBytes}-byte bound`)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim().length > 0) {
      const event = parseBlock(buffer)
      if (event !== undefined) yield event
    }
  } finally {
    release()
  }
}

/** Codex identity headers that mirror the Codex CLI for remote compaction v2. */
export function remoteCompactionHeaders(input: {
  accessToken: string
  accountID?: string
  originator?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    accept: "text/event-stream",
    "content-type": "application/json",
    "x-codex-beta-features": REMOTE_COMPACTION_V2_FEATURE,
    "OpenAI-Beta": "responses=experimental",
    ...(input.originator ? { originator: input.originator } : {}),
  }
  if (input.accountID) headers["ChatGPT-Account-ID"] = input.accountID
  return headers
}

export function buildRemoteCompactionBody(input: {
  modelID: string
  items: CodexResponseItem[]
  sessionID?: string
}): Record<string, unknown> {
  return {
    model: input.modelID,
    input: [...input.items, { type: "compaction_trigger" }],
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(input.sessionID ? { prompt_cache_key: input.sessionID } : {}),
  }
}

export function extractRemoteCompactionMetadata(value: unknown): CodexRemoteCompactionMetadata | undefined {
  if (!isRecord(value)) return undefined
  const remote = isRecord(value.remoteCompaction) ? value.remoteCompaction : value
  if (!isRecord(remote)) return undefined
  if (remote.version !== 2 || remote.provider !== "openai-responses-compaction") return undefined
  if (!Array.isArray(remote.replacementHistory)) return undefined
  const replacementHistory = remote.replacementHistory.filter(isCodexResponseItem)
  if (replacementHistory.length === 0) return undefined
  return {
    version: 2,
    provider: "openai-responses-compaction",
    implementation: "responses_compaction_v2",
    modelKey: typeof remote.modelKey === "string" ? remote.modelKey : "",
    providerID: typeof remote.providerID === "string" ? remote.providerID : "",
    modelID: typeof remote.modelID === "string" ? remote.modelID : "",
    ...(typeof remote.apiModelID === "string" && remote.apiModelID !== "" ? { apiModelID: remote.apiModelID } : {}),
    summaryText: typeof remote.summaryText === "string" ? remote.summaryText : "",
    replacementHistory,
    ...(isRecord(remote.usage) ? { usage: remote.usage as CodexRemoteCompactionUsage } : {}),
  }
}

/** Joined output text of an assistant message item ("" for non-text shapes). */
function assistantOutputText(item: CodexResponseItem): string | undefined {
  if (!isCodexMessageItem(item) || item.role !== "assistant") return undefined
  if (typeof item.content === "string") return item.content
  const content = item.content
  if (content.some((part) => part.type !== "output_text" && part.type !== "summary_text")) return undefined
  return content
    .filter(
      (part): part is { type: "output_text" | "summary_text"; text: string } =>
        (part.type === "output_text" || part.type === "summary_text") && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
}

/** Whitespace-tolerant equality: exact match, else ignoring all whitespace. */
function summaryTextMatches(candidate: string, summaryText: string): boolean {
  if (candidate === summaryText) return true
  return candidate.replace(/\s+/g, "") === summaryText.replace(/\s+/g, "")
}

/**
 * Locate the summary window inside a serialized request body: the maximal run
 * of consecutive assistant message items whose joined output text matches the
 * stored summary text (exact first, whitespace-tolerant as a fallback for
 * storage/part-boundary differences). Returns `undefined` when no such window
 * exists.
 */
export function findSummaryWindow(
  items: CodexResponseItem[],
  startIndex: number,
  summaryText: string,
): { start: number; end: number } | undefined {
  if (!summaryText) return undefined
  for (let index = startIndex; index < items.length; index++) {
    const firstText = assistantOutputText(items[index])
    if (firstText === undefined) continue
    let end = index + 1
    let joined = firstText
    while (end < items.length) {
      const nextText = assistantOutputText(items[end])
      if (nextText === undefined) break
      joined += nextText
      end++
    }
    if (summaryTextMatches(joined, summaryText)) return { start: index, end }
    // A longer run cannot contain the summary starting later inside itself.
    index = end - 1
  }
  return undefined
}

function textOf(part: CodexModelPartLike): string {
  return typeof part.text === "string" ? part.text : ""
}

/**
 * Convert AI-SDK-shaped prompt messages (role/content parts) into Responses
 * `input` items, mirroring the SDK's own serialization rules for `store:
 * false`:
 * - system → developer message item (reasoning model) with string content
 * - user text → input_text; image/file → input_image base64
 * - assistant text → one assistant item per text part with output_text;
 *   tool-calls → function_call; reasoning without encrypted content is
 *   dropped (SDK drops it when store is false); provider-executed tool
 *   results are skipped
 * - tool results → function_call_output
 *
 * Used to build the remote compaction request body from the same local
 * history the SDK would serialize.
 */
export function modelMessagesToItems(messages: CodexModelMessageLike[]): CodexResponseItem[] {
  const items: CodexResponseItem[] = []
  for (const message of messages) {
    const role = message.role
    const content = message.content
    if (role === "system" && typeof content === "string") {
      items.push({ role: "developer", content })
      continue
    }
    if (role === "user" && Array.isArray(content)) {
      const parts: CodexResponseContentItem[] = []
      for (const part of content as CodexModelPartLike[]) {
        if (part.type === "text") {
          const text = textOf(part)
          if (text.length > 0) parts.push({ type: "input_text", text })
        } else if (part.type === "file") {
          const mediaType = typeof part.mediaType === "string" ? part.mediaType : ""
          const data = part.data
          if (mediaType.startsWith("image/") && typeof data === "string" && data.length > 0) {
            // The model-message projection supplies `data` as the existing
            // attachment URL (a complete data: URL or an HTTP(S) URL); only a
            // bare base64 payload needs the prefix. Wrapping an existing URL
            // again would produce malformed input like
            // data:image/png;base64,data:image/png;base64,...
            const imageUrl =
              data.startsWith("data:") || data.startsWith("http://") || data.startsWith("https://")
                ? data
                : `data:${mediaType};base64,${data}`
            parts.push({ type: "input_image", image_url: imageUrl })
          }
        }
      }
      if (parts.length > 0) items.push({ role: "user", content: parts })
      continue
    }
    if (role === "assistant" && Array.isArray(content)) {
      for (const part of content as CodexModelPartLike[]) {
        if (part.type === "text") {
          const text = textOf(part)
          if (text.length > 0) {
            items.push({ role: "assistant", content: [{ type: "output_text", text }] })
          }
        } else if (part.type === "reasoning") {
          // store=false drops reasoning without encrypted content; we never
          // have encrypted content locally, so skip it for parity.
          continue
        } else if (part.type === "tool-call") {
          if ((part as { providerExecuted?: unknown }).providerExecuted === true) continue
          const input = part.input
          items.push({
            type: "function_call",
            call_id: typeof part.toolCallId === "string" ? part.toolCallId : "",
            name: typeof part.toolName === "string" ? part.toolName : "",
            arguments: isRecord(input) ? JSON.stringify(input) : typeof input === "string" ? input : "{}",
          })
        } else if (part.type === "tool-result") {
          // Provider-executed tool results are not sent when store is false.
          continue
        }
      }
      continue
    }
    if (role === "tool" && Array.isArray(content)) {
      for (const part of content as CodexModelPartLike[]) {
        if (part.type !== "tool-result") continue
        const output = part.output
        let text: string
        if (isRecord(output)) {
          const value = output.value
          text = typeof value === "string" ? value : JSON.stringify(value ?? "")
        } else {
          text = typeof output === "string" ? output : JSON.stringify(output ?? "")
        }
        items.push({
          type: "function_call_output",
          call_id: typeof part.toolCallId === "string" ? part.toolCallId : "",
          output: text,
        })
      }
    }
  }
  return items
}

/**
 * Splice the persisted replacement history into a serialized codex `/responses`
 * request body. Conservative by design: unless every structural expectation
 * holds, the body is returned unchanged so the request falls back to the
 * normal local-history replay.
 *
 * Structural expectations:
 * - the body has an `input` item array;
 * - the request is a normal turn (its last input item is not a
 *   `compaction_trigger`, which would mean this body is itself a remote
 *   compaction request);
 * - a leading run of `developer`/`system` message items (the SDK-emitted
 *   system prompt) can be identified as the prefix;
 * - the stored summary text appears (exactly, or whitespace-tolerantly) as
 *   the joined output of one consecutive run of assistant message items
 *   at/after the prefix, and every item between the prefix and that run is a
 *   user message (the compaction boundary root);
 * - the replacement history is a non-empty array ending in a `compaction`
 *   item (never truncated/rewritten).
 */
export function applyReplaySplice(
  body: Record<string, unknown>,
  plan: CodexReplayPlan,
): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined
  if (!Array.isArray(body.input)) return undefined
  const items = body.input as CodexResponseItem[]
  if (items.length === 0) return undefined

  // Never splice a compaction request body: it carries its own full history
  // plus the trailing trigger and must reach the endpoint untouched.
  const lastItem = items[items.length - 1]
  if (lastItem && "type" in lastItem && lastItem.type === "compaction_trigger") return undefined

  // Leading developer/system run = the SDK-emitted system prompt prefix.
  let prefixEnd = 0
  while (prefixEnd < items.length) {
    const item = items[prefixEnd]
    if (!isCodexMessageItem(item) || (item.role !== "developer" && item.role !== "system")) break
    prefixEnd++
  }

  const window = findSummaryWindow(items, prefixEnd, plan.summaryText)
  if (!window) return undefined

  // Everything between the system prefix and the summary must be user messages
  // (the compaction boundary root). Anything else means the projection shape
  // is not what this splice understands — fall back to local replay.
  for (let index = prefixEnd; index < window.start; index++) {
    const item = items[index]
    if (!isCodexMessageItem(item) || item.role !== "user") return undefined
  }

  const replacement = plan.replacementHistory
  if (!Array.isArray(replacement) || replacement.length === 0) return undefined
  const compaction = replacement[replacement.length - 1]
  if (!compaction || !("type" in compaction) || compaction.type !== "compaction") return undefined

  const next: Record<string, unknown> = { ...body }
  next.input = [...items.slice(0, prefixEnd), ...replacement.map((item) => cloneItem(item)), ...items.slice(window.end)]
  return next
}

// ── Worker-side per-turn replay registry ───────────────────────────────────
// The agent turn runs in a worker process where the codex fetch closure only
// knows the resolved prompt-cache key from the serialized request body. The
// registry is populated per turn by `LLM.stream` (sessionID + resolved cache
// key + plan) and consumed by the fetch body rewrite, which looks up by the
// body's `prompt_cache_key`. The sessionID→cacheKey mapping lets the runner
// release the entry by sessionID when the turn finishes (completion, failure,
// and cancellation all flow through the runner's terminal path), so a
// long-lived worker never retains per-session artifacts between turns.

const replayRegistry = new Map<string, CodexReplayPlan>()
const sessionReplayKeys = new Map<string, string>()

export function setReplayPlan(sessionID: string, cacheKey: string, plan: CodexReplayPlan | undefined): void {
  const previousKey = sessionReplayKeys.get(sessionID)
  if (previousKey !== undefined) replayRegistry.delete(previousKey)
  if (plan === undefined) {
    sessionReplayKeys.delete(sessionID)
    return
  }
  sessionReplayKeys.set(sessionID, cacheKey)
  replayRegistry.set(cacheKey, plan)
}

export function getReplayPlan(cacheKey: string): CodexReplayPlan | undefined {
  return replayRegistry.get(cacheKey)
}

/** Release the plan registered for a session (called when its turn ends). */
export function clearReplayPlan(sessionID: string): void {
  const cacheKey = sessionReplayKeys.get(sessionID)
  sessionReplayKeys.delete(sessionID)
  if (cacheKey !== undefined) replayRegistry.delete(cacheKey)
}

/** Release a plan by its resolved prompt-cache key (replay rejection path). */
export function clearReplayPlanForCacheKey(cacheKey: string): void {
  replayRegistry.delete(cacheKey)
  for (const [sessionID, key] of sessionReplayKeys) {
    if (key === cacheKey) sessionReplayKeys.delete(sessionID)
  }
}

/** Normalize a Responses usage payload into a compact usage snapshot. */
export function normalizeUsage(value: unknown): CodexRemoteCompactionUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0
  const rawDetails = value.input_tokens_details
  const details = isRecord(rawDetails) ? rawDetails : undefined
  const cached = details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0
  return {
    input: Math.max(0, inputTokens - cached),
    output: outputTokens,
    cacheRead: cached,
    totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens,
  }
}
