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
 * Claude Code transcript converter.
 *
 * Claude Code stores one JSON object per line under
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The format is
 * internal and can change between releases, so unknown line types and
 * malformed lines are skipped and counted instead of failing the import.
 *
 * Recognized line types:
 * - `user` / `assistant` — conversation turns with `message.content` blocks
 *   (`text`, `tool_use`, `tool_result`, `thinking`)
 * - `summary` — session title
 * - `custom-title` — explicit session title
 * - `isSidechain: true` — subagent sessions, skipped by default
 */

interface ClaudeLine {
  type?: string
  isSidechain?: boolean
  uuid?: string
  leafUuid?: string
  cwd?: string
  timestamp?: string | number
  message?: {
    role?: string
    content?: string | unknown[]
    model?: string
  }
  summary?: string
  customTitle?: string
}
export interface ClaudeCodeConvertOptions {
  /** Include subagent (sidechain) sessions. Defaults to false. */
  includeSidechains?: boolean
  /** Include thinking blocks as reasoning parts. Defaults to false. */
  includeThinking?: boolean
  /**
   * Original working directory for this transcript, decoded from the
   * `~/.claude/projects/<encoded-cwd>/` directory name. Takes precedence
   * over any `cwd` field found inside the transcript (older formats).
   */
  cwd?: string
}

export interface ClaudeCodeConvertResult {
  report: SessionExport.Report
  stats: ForeignImportStats
}

export function parseClaudeCodeTranscript(
  text: string,
  options: ClaudeCodeConvertOptions = {},
): ClaudeCodeConvertResult {
  const stats: ForeignImportStats = { skippedLines: 0, unknownTypes: 0, warnings: [] }
  const lines = parseJsonLines(text, stats) as ClaudeLine[]

  const messages: ForeignMessage[] = []
  let title: string | undefined
  // The working directory comes from the `~/.claude/projects/<encoded-cwd>/`
  // directory name (decoded by the caller), or from a `cwd` field embedded in
  // newer transcripts (uploaded files that lost their path).
  let cwd = options.cwd
  // Tool results arrive in a later user turn; map call IDs to the tool parts
  // created earlier so results can be attached across messages.
  const toolParts = new Map<string, Extract<ForeignPart, { type: "tool" }>>()
  for (const line of lines) {
    if (!line || typeof line !== "object") {
      stats.skippedLines++
      continue
    }
    if (line.isSidechain && !options.includeSidechains) continue
    // Newer transcripts embed the working directory; use it only when the
    // caller did not already derive one from the file path.
    if (!cwd && typeof line.cwd === "string" && line.cwd) cwd = line.cwd

    switch (line.type) {
      case "user":
      case "assistant": {
        const role = line.type === "user" ? "user" : "assistant"
        const created = timestampToEpoch(line.timestamp)
        const parts = contentParts(line, options, toolParts)
        // Tool-result-only user turns carry no visible text; the result was
        // attached to the original tool call, so there is nothing to keep.
        if (parts.length === 0) continue
        messages.push({ id: messageID(line.uuid), role, created, parts })
        break
      }
      case "summary":
        if (typeof line.summary === "string" && line.summary.trim() && !title) {
          title = line.summary.trim().slice(0, 200)
        }
        break
      case "custom-title":
        if (typeof line.customTitle === "string" && line.customTitle.trim()) {
          title = line.customTitle.trim().slice(0, 200)
        }
        break
      case "system":
      case "file-history-snapshot":
      case "attachment":
      case "permission-mode":
      case "agent-name":
      case "progress":
      case "usage":
      case "cache":
      case "diff":
      case "todo":
      case "plan":
        // metadata lines — ignored
        break
      default:
        stats.unknownTypes++
    }
  }

  linkTurns(messages)

  const session: ForeignSession = {
    id: sessionID(),
    title: title ?? firstUserText(messages) ?? "Imported Claude Code session",
    cwd,
    created: messages[0]?.created ?? Date.now(),
    updated: messages[messages.length - 1]?.created ?? Date.now(),
    messages,
  }

  return { report: buildReport({ source: "claude-code", session }), stats }
}

/**
 * Decode an encoded project directory name (`-Users-me-project` →
 * `/Users/me/project`). Claude Code replaces path separators with `-` before
 * URL-encoding, so decoding is best-effort for directory names that contain
 * literal hyphens. Falls back to `undefined` when the name is not a path.
 */
export function decodeProjectDir(name: string): string | undefined {
  if (!name) return undefined
  if (name.startsWith("-")) {
    const rest = name.slice(1).replace(/-/g, "/")
    return rest.startsWith("/") ? rest : `/${rest}`
  }
  const decoded = decodeURIComponent(name)
  if (!decoded.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(decoded)) return undefined
  return decoded
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

function contentParts(
  line: ClaudeLine,
  options: ClaudeCodeConvertOptions,
  toolParts: Map<string, Extract<ForeignPart, { type: "tool" }>>,
): ForeignPart[] {
  const content = line.message?.content
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const parts: ForeignPart[] = []

  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    switch (b.type) {
      case "text": {
        const text = typeof b.text === "string" ? b.text : ""
        if (text.trim()) parts.push({ type: "text", text })
        break
      }
      case "thinking": {
        if (options.includeThinking !== true) break
        const text = typeof b.thinking === "string" ? b.thinking : ""
        if (text.trim()) parts.push({ type: "reasoning", text })
        break
      }
      case "tool_use": {
        const id = typeof b.id === "string" ? b.id : `tool_${parts.length}`
        const name = typeof b.name === "string" ? b.name : "unknown"
        const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {}
        const part: Extract<ForeignPart, { type: "tool" }> = { type: "tool", callID: id, tool: name, input }
        toolParts.set(id, part)
        parts.push(part)
        break
      }
      case "tool_result": {
        // Attach the result to the tool call that was created earlier (in an
        // assistant turn) and drop the result-only wrapper turn.
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
        const output = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")
        if (id) {
          const part = toolParts.get(id)
          if (part) part.output = output
        }
        break
      }
      default:
        // unknown content block — ignore
        break
    }
  }

  return parts
}
