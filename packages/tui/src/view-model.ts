import type { FileDiff, Message, Part } from "@ericsanchezok/synergy-sdk/client"
import { sanitizeTerminalLabel, sanitizeTerminalLine, sanitizeTerminalText } from "./sanitization.js"

export type ViewTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger"

export type ViewBlock = {
  id: string
  kind: "text" | "markdown" | "diff"
  content: string
  tone: ViewTone
  collapsible?: boolean
}

export type MessageView = {
  id: string
  label: string
  meta: string
  blocks: ViewBlock[]
}

export type PartRenderOptions = {
  expandedReasoning?: ReadonlySet<string>
  maxOutputCharacters?: number
}

const DEFAULT_MAX_OUTPUT_CHARACTERS = 4096
const OUTPUT_TRUNCATION_SUFFIX = "\n… output truncated by Synergy TUI"

function boundedText(input: string, limit: number) {
  const safe = sanitizeTerminalText(input)
  if (safe.length <= limit) return safe
  return `${safe.slice(0, Math.max(0, limit - OUTPUT_TRUNCATION_SUFFIX.length))}${OUTPUT_TRUNCATION_SUFFIX}`
}

function block(part: Part, content: string, tone: ViewTone, kind: ViewBlock["kind"] = "text"): ViewBlock {
  return { id: part.id, kind, content, tone }
}

function errorMessage(error: unknown) {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined
  const message = data && typeof data === "object" && "message" in data ? data.message : undefined
  return sanitizeTerminalLabel(typeof message === "string" ? message : "Unknown error", "Unknown error")
}

function renderTool(part: Extract<Part, { type: "tool" }>, options: PartRenderOptions): ViewBlock {
  const name = sanitizeTerminalLabel(part.tool, "Unknown tool")
  switch (part.state.status) {
    case "pending":
      return block(part, `○ ${name} · waiting`, "warning")
    case "generating":
      return block(part, `◐ ${name} · preparing input · ${part.state.charsReceived} characters`, "accent")
    case "running":
      return block(
        part,
        `● ${name}${part.state.title ? ` · ${sanitizeTerminalLabel(part.state.title, "Untitled operation")}` : ""}`,
        "accent",
      )
    case "completed": {
      const output = boundedText(part.state.output, options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS)
      const truncation = part.state.outputTruncated ? " · output truncated at source" : ""
      return block(
        part,
        `✓ ${sanitizeTerminalLabel(part.state.title, "Completed tool")}${truncation}${output ? `\n${output}` : ""}`,
        "success",
      )
    }
    case "error":
      return block(part, `✕ ${name} · ${sanitizeTerminalLabel(part.state.error, "Unknown error")}`, "danger")
  }
}

function renderStepFinish(part: Extract<Part, { type: "step-finish" }>) {
  const tokens = part.tokens
  return `Step finished · ${sanitizeTerminalLabel(part.reason, "unknown reason")} · tokens ${tokens.input} in · ${tokens.output} out · ${tokens.reasoning} reasoning · $${part.cost.toFixed(4)}`
}

function renderRecovery(part: Extract<Part, { type: "compaction_recovery" }>) {
  const flags = [part.mechanical ? "mechanical" : "model", part.validated ? "validated" : "unvalidated"]
  if (part.recoverySessionIDs?.length)
    flags.push(`sessions ${part.recoverySessionIDs.map(sanitizeTerminalLine).join(", ")}`)
  return `${sanitizeTerminalLabel(part.summary, "Recovery summary unavailable")} · ${flags.join(" · ")}`
}

export function renderPart(part: Part, options: PartRenderOptions = {}): ViewBlock {
  switch (part.type) {
    case "text":
      return block(part, sanitizeTerminalText(part.text), part.origin === "system" ? "muted" : "normal", "markdown")
    case "reasoning": {
      if (!options.expandedReasoning?.has(part.id)) {
        return { ...block(part, `▸ Reasoning · ${part.text.length} characters`, "muted"), collapsible: true }
      }
      return {
        ...block(part, sanitizeTerminalText(part.text), "muted", "markdown"),
        collapsible: true,
      }
    }
    case "tool":
      return renderTool(part, options)
    case "step-start":
      return block(
        part,
        `── Step started${part.snapshot ? ` · snapshot ${sanitizeTerminalLine(part.snapshot)}` : ""}`,
        "muted",
      )
    case "step-finish":
      return block(part, renderStepFinish(part), "muted")
    case "attachment": {
      const location = part.localPath ?? part.url
      const label = part.filename ?? "attachment"
      return block(
        part,
        `Attachment · ${sanitizeTerminalLabel(label, "attachment")} · ${sanitizeTerminalLabel(part.mime, "unknown type")} · ${sanitizeTerminalLabel(location, "unknown location")} · content not renderable in TUI`,
        "accent",
      )
    }
    case "snapshot":
      return block(part, `Snapshot ${sanitizeTerminalLabel(part.snapshot, "unknown snapshot")}`, "muted")
    case "patch":
      return block(
        part,
        `Patch ${sanitizeTerminalLabel(part.hash, "unknown patch")} · ${part.files.map((file) => sanitizeTerminalLabel(file, "unknown file")).join(", ")}`,
        "success",
      )
    case "retry":
      return block(part, `↻ Retry ${part.attempt} · ${errorMessage(part.error)}`, "warning")
    case "compaction":
      return block(part, `Context compacted · ${part.auto ? "automatic" : "manual"}`, "muted")
    case "compaction_recovery":
      return block(part, renderRecovery(part), part.validated ? "success" : "warning")
  }
}

function renderDiff(diff: FileDiff, messageID: string, index: number): ViewBlock {
  const summary = `${sanitizeTerminalLabel(diff.file, "unknown file")} · +${diff.additions} -${diff.deletions}${diff.binary ? " · binary" : ""}`
  const preview = diff.preview ? sanitizeTerminalText(diff.preview) : ""
  return {
    id: `${messageID}:diff:${index}`,
    kind: preview ? "diff" : "text",
    content: preview ? `${summary}\n${preview}` : summary,
    tone: "success",
    collapsible: diff.truncated,
  }
}

function messageError(message: Message): ViewBlock | undefined {
  if (message.role !== "assistant" || !message.error) return undefined
  return {
    id: `${message.id}:error`,
    kind: "text",
    content: errorMessage(message.error),
    tone: "danger",
  }
}

function messageMeta(message: Message) {
  if (message.role === "user") return sanitizeTerminalLabel(message.agent, "unknown agent")
  const tokens = message.tokens
  const completion = message.time.completed ? " · done" : " · streaming"
  return `${sanitizeTerminalLabel(message.agent, "unknown agent")} · ${tokens.input} in · ${tokens.output} out · ${tokens.reasoning} reasoning · $${message.cost.toFixed(4)}${completion}`
}

export function buildMessageView(message: Message, parts: Part[], options: PartRenderOptions = {}): MessageView {
  const blocks = parts.map((part) => renderPart(part, options))
  if (message.role === "user") {
    for (const [index, diff] of (message.summary?.diffs ?? []).entries())
      blocks.push(renderDiff(diff, message.id, index))
  }
  const error = messageError(message)
  if (error) blocks.push(error)
  return {
    id: message.id,
    label: message.role === "user" ? "YOU" : `SYNERGY · ${sanitizeTerminalLabel(message.agent, "unknown agent")}`,
    meta: messageMeta(message),
    blocks,
  }
}
