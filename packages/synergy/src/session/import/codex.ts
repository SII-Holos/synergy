import { SessionExport } from "../session-export"
import {
  type ForeignImportStats,
  type ForeignMessage,
  type ForeignPart,
  type ForeignSession,
  buildReport,
  linkTurns,
  messageID,
  parseJsonLines,
  sessionID,
} from "./shared"

/**
 * Codex CLI transcript converter.
 *
 * Codex stores one JSON object per line under
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` (and optionally
 * `~/.codex/archived_sessions/...`). The format is internal and evolving, so
 * unknown line types and malformed lines are skipped and counted instead of
 * failing the import.
 *
 * Recognized line types (verified against local rollouts):
 * - `session_meta` — `cwd`, `id`, `source`, `timestamp`, `model_provider`
 * - `turn_context` — `cwd`, `model`, `summary`
 * - `response_item` / `payload.type`:
 *   - `message` — `role` + `content` blocks (`input_text`, `output_text`,
 *     `input_image`, `refusal`)
 *   - `reasoning` — `content` / `summary` / `encrypted_content`
 *   - `function_call` — `call_id`, `name`, `arguments` (JSON string)
 *   - `function_call_output` — `call_id`, `output`
 *   - `custom_tool_call` — `call_id`, `name`, `input`, `status`
 *   - `custom_tool_call_output` — `call_id`, `output`
 * - `event_msg` / `payload.type`:
 *   - `user_message` / `agent_message` — `message` (text)
 *   - `agent_reasoning` — `text`
 *   - `token_count` — cumulative usage, ignored (we do not import tokens)
 */

interface CodexLine {
  type?: string
  timestamp?: string | number
  payload?: {
    type?: string
    role?: string
    content?: unknown[]
    call_id?: string
    name?: string
    arguments?: string
    input?: unknown
    output?: string | unknown
    status?: string
    message?: string | unknown
    text?: string
    summary?: string | unknown
    model?: string
    cwd?: string
    source?: string
    id?: string
  }
}

export interface CodexConvertOptions {
  /** Include reasoning blocks as reasoning parts. Defaults to false. */
  includeReasoning?: boolean
}

export interface CodexConvertResult {
  report: SessionExport.Report
  stats: ForeignImportStats
}

export function parseCodexTranscript(text: string, options: CodexConvertOptions = {}): CodexConvertResult {
  const stats: ForeignImportStats = { skippedLines: 0, unknownTypes: 0, warnings: [] }
  const lines = parseJsonLines(text, stats) as CodexLine[]

  const messages: ForeignMessage[] = []
  let cwd: string | undefined
  let title: string | undefined
  let model: string | undefined
  // Map from call_id → the tool part it belongs to, so `function_call_output`
  // lines can complete the matching tool call regardless of position.
  const toolParts = new Map<string, Extract<ForeignPart, { type: "tool" }>>()

  for (const line of lines) {
    if (!line || typeof line !== "object") {
      stats.skippedLines++
      continue
    }
    const payload = line.payload
    if (!payload || typeof payload !== "object") {
      stats.unknownTypes++
      continue
    }
    const created = timestampToEpoch(line.timestamp)
    const ptype = payload.type

    switch (line.type) {
      case "session_meta": {
        if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd
        // Fallback titles: the session summary from turn_context is preferred,
        // so only set these when no summary is expected later.
        if (typeof payload.source === "string" && payload.source && !title) title = payload.source.slice(0, 200)
        if (typeof payload.id === "string" && !title) title = payload.id.slice(0, 200)
        break
      }
      case "turn_context": {
        if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd
        if (typeof payload.model === "string" && payload.model) model = payload.model
        if (typeof payload.summary === "string" && payload.summary.trim()) {
          title = payload.summary.trim().slice(0, 200)
        }
        break
      }
      case "response_item":
        handleResponseItem(payload, created, messages, toolParts, stats, options)
        break
      case "event_msg":
        handleEventMsg(payload, created, messages, stats, options)
        break
      case "input_item":
      case "config_snapshot":
        // metadata lines — ignored
        break
      default:
        stats.unknownTypes++
    }
  }

  linkTurns(messages)

  const session: ForeignSession = {
    id: sessionID(),
    title: title ?? firstUserText(messages) ?? "Imported Codex session",
    cwd,
    created: messages[0]?.created ?? Date.now(),
    updated: messages[messages.length - 1]?.created ?? Date.now(),
    messages,
  }

  const report = buildReport({
    source: "codex",
    session,
    model: model ? { providerID: "openai", modelID: model } : undefined,
  })
  return { report, stats }
}

function handleResponseItem(
  payload: NonNullable<CodexLine["payload"]>,
  created: number,
  messages: ForeignMessage[],
  toolParts: Map<string, Extract<ForeignPart, { type: "tool" }>>,
  stats: ForeignImportStats,
  options: CodexConvertOptions,
): void {
  switch (payload.type) {
    case "message": {
      const role = payload.role === "user" ? "user" : "assistant"
      const parts = contentParts(payload.content)
      if (parts.length === 0) break
      messages.push({ id: messageID(), role, created, parts })
      break
    }
    case "reasoning": {
      if (options.includeReasoning !== true) break
      const text = typeof payload.summary === "string" ? payload.summary : ""
      if (!text.trim()) break
      messages.push({
        id: messageID(),
        role: "assistant",
        created,
        parts: [{ type: "reasoning", text }],
      })
      break
    }
    case "function_call":
    case "custom_tool_call": {
      const callID = typeof payload.call_id === "string" ? payload.call_id : `call_${toolParts.size}`
      const name = typeof payload.name === "string" ? payload.name : "unknown"
      const input =
        payload.type === "function_call"
          ? parseArguments(payload.arguments)
          : payload.input && typeof payload.input === "object"
            ? (payload.input as Record<string, unknown>)
            : {}
      const part: Extract<ForeignPart, { type: "tool" }> = { type: "tool", callID, tool: name, input }
      toolParts.set(callID, part)
      messages.push({ id: messageID(), role: "assistant", created, parts: [part] })
      break
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callID = typeof payload.call_id === "string" ? payload.call_id : undefined
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "")
      if (callID) {
        const part = toolParts.get(callID)
        if (part) part.output = output
        else
          messages.push({
            id: messageID(),
            role: "user",
            created,
            parts: [{ type: "tool", callID, tool: "unknown", input: {}, output }],
          })
      }
      break
    }
    default:
      stats.unknownTypes++
  }
}

function handleEventMsg(
  payload: NonNullable<CodexLine["payload"]>,
  created: number,
  messages: ForeignMessage[],
  stats: ForeignImportStats,
  options: CodexConvertOptions,
): void {
  switch (payload.type) {
    case "user_message": {
      const text = messageText(payload.message)
      if (!text.trim()) break
      messages.push({ id: messageID(), role: "user", created, parts: [{ type: "text", text }] })
      break
    }
    case "agent_message": {
      const text = messageText(payload.message)
      if (!text.trim()) break
      messages.push({ id: messageID(), role: "assistant", created, parts: [{ type: "text", text }] })
      break
    }
    case "agent_reasoning": {
      if (options.includeReasoning !== true) break
      const text = typeof payload.text === "string" ? payload.text : ""
      if (!text.trim()) break
      messages.push({ id: messageID(), role: "assistant", created, parts: [{ type: "reasoning", text }] })
      break
    }
    case "token_count":
      // cumulative token usage — not imported
      break
    default:
      stats.unknownTypes++
  }
}

function contentParts(content: unknown[] | undefined): ForeignPart[] {
  if (!Array.isArray(content)) return []
  const parts: ForeignPart[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    switch (b.type) {
      case "input_text":
      case "output_text": {
        const text = typeof b.text === "string" ? b.text : ""
        if (text.trim()) parts.push({ type: "text", text })
        break
      }
      case "refusal": {
        const text = typeof b.refusal === "string" ? b.refusal : ""
        if (text.trim()) parts.push({ type: "text", text })
        break
      }
      case "input_image":
      case "output_image":
      case "input_audio":
      case "input_file":
      case "function_call":
      case "function_call_output":
      case "custom_tool_call":
      case "custom_tool_call_output":
        // attachments / nested tool events — ignored for the text-only import
        break
      default:
        // unknown content block — ignore
        break
    }
  }
  return parts
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return { raw }
  }
}

function messageText(value: string | unknown | undefined): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>
    if (typeof v.text === "string") return v.text
    if (Array.isArray(v.content)) {
      const texts: string[] = []
      for (const block of v.content) {
        if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
          texts.push((block as Record<string, unknown>).text as string)
        }
      }
      if (texts.length > 0) return texts.join("\n")
    }
    return JSON.stringify(value)
  }
  return ""
}

function timestampToEpoch(value: string | number | undefined): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return Date.now()
}

function firstUserText(messages: ForeignMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.parts.find((part): part is Extract<ForeignPart, { type: "text" }> => part.type === "text")
    if (text?.text.trim()) return text.text.slice(0, 200)
  }
  return undefined
}
