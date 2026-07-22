import { NATIVE_MAX_ARRAY_LENGTH, NATIVE_MAX_OBJECT_DEPTH, NATIVE_MAX_OBJECT_KEYS } from "@/holos/native"
import type { RuntimeTaskAssignedEvent } from "./agent-tunnel-port"

const MAX_TEXT_FIELD_LENGTH = 32_768
const MAX_STRUCTURED_FIELD_LENGTH = 32_768
const MAX_NESTED_STRING_LENGTH = 8_192
const TRUNCATED_SUFFIX = "\n[truncated]"

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - TRUNCATED_SUFFIX.length))}${TRUNCATED_SUFFIX}`
}

function stableJSON(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(boundedText(value, MAX_NESTED_STRING_LENGTH))
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "bigint") return JSON.stringify(value.toString())
  if (value === undefined) return "null"
  if (typeof value !== "object") return JSON.stringify(String(value))
  if (seen.has(value)) return JSON.stringify("[circular]")
  if (depth >= NATIVE_MAX_OBJECT_DEPTH) return JSON.stringify("[max depth]")

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const values = value.slice(0, NATIVE_MAX_ARRAY_LENGTH).map((item) => stableJSON(item, depth + 1, seen))
      if (value.length > NATIVE_MAX_ARRAY_LENGTH) {
        values.push(JSON.stringify(`[${value.length - NATIVE_MAX_ARRAY_LENGTH} more items]`))
      }
      return `[${values.join(",")}]`
    }

    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const included = keys.slice(0, NATIVE_MAX_OBJECT_KEYS)
    const entries = included.map((key) => `${JSON.stringify(key)}:${stableJSON(record[key], depth + 1, seen)}`)
    if (keys.length > NATIVE_MAX_OBJECT_KEYS) {
      entries.push(`${JSON.stringify("[truncated keys]")}:${keys.length - NATIVE_MAX_OBJECT_KEYS}`)
    }
    return `{${entries.join(",")}}`
  } finally {
    seen.delete(value)
  }
}

function structuredText(value: Record<string, unknown>): string {
  return boundedText(stableJSON(value), MAX_STRUCTURED_FIELD_LENGTH)
}

function addTextSection(lines: string[], label: string, value: string | null | undefined): void {
  const normalized = value?.trim()
  if (!normalized) return
  lines.push(`**${label}**`, boundedText(normalized, MAX_TEXT_FIELD_LENGTH), "")
}

function addStructuredSection(lines: string[], label: string, value: Record<string, unknown> | null | undefined): void {
  if (!value) return
  lines.push(`**${label}**`, structuredText(value), "")
}

export namespace ClarusAssignmentPrompt {
  export function title(event: RuntimeTaskAssignedEvent): string {
    const value = event.goal?.trim() || event.instructions?.trim() || event.taskID
    return value.length > 120 ? `${value.slice(0, 117)}...` : value
  }

  export function userPrompt(accountId: string, event: RuntimeTaskAssignedEvent): string {
    const lines = [
      "## Clarus assignment",
      "",
      `Account: ${accountId}`,
      `Project: ${event.projectID}`,
      `Run: ${event.runID}`,
      `Task: ${event.taskID}`,
      `Subtask: ${event.subtaskID}`,
      `Phase: ${event.phase}`,
      `Attempt: ${event.attempt}`,
    ]
    if (event.attemptMode) lines.push(`Attempt mode: ${event.attemptMode}`)
    lines.push(`Deadline: ${event.deadlineAt ?? "none"}`)
    if (event.retryOfTaskID) lines.push(`Retry of: ${event.retryOfTaskID}`)
    lines.push("")

    addTextSection(lines, "Goal", event.goal)
    addTextSection(lines, "Instructions", event.instructions)
    addStructuredSection(lines, "Input", event.input)
    addStructuredSection(lines, "Context", event.context)
    addStructuredSection(lines, "Task input", event.taskInput)
    return lines.join("\n")
  }

  export function participationGuidance(event: RuntimeTaskAssignedEvent): string {
    return [
      "This Session executes an external Clarus task as an autonomous agent.",
      "Report meaningful progress through the Clarus participation workflow.",
      "Use the Clarus deadline extension mechanism before the deadline when more time is required.",
      "Submit the final result and artifacts through the Clarus result mechanism.",
      "A not-dispatched result may be retried; rejected or ambiguous results must not be retried automatically.",
      "Project messages are not a task-control channel.",
      "The user may Abort this local Session to stop execution.",
      "Follow the built-in clarus-agent-participation skill for the exact operational workflow.",
      "",
      `Task ID: ${event.taskID}`,
      `Project: ${event.projectID}`,
      `Run: ${event.runID}`,
    ].join("\n")
  }
}

export namespace ClarusDeadline {
  export const MIN_LEAD_MS = 30_000
  export const MAX_LEAD_MS = 300_000
  const LEAD_FRACTION = 0.1
  const IMMEDIATE_DELAY_MS = 1_000

  export function leadMs(deadlineAt: number, now = Date.now()): number {
    const window = deadlineAt - now
    if (window <= MIN_LEAD_MS) return MIN_LEAD_MS
    return Math.min(MAX_LEAD_MS, Math.max(MIN_LEAD_MS, Math.round(window * LEAD_FRACTION)))
  }

  export function triggerAt(deadlineAt: number, now = Date.now()): number {
    return Math.max(now + IMMEDIATE_DELAY_MS, deadlineAt - leadMs(deadlineAt, now))
  }

  export function guidance(): string {
    return "The Clarus task deadline is approaching. Submit the result now or extend the deadline using the Clarus participation tools."
  }
}
