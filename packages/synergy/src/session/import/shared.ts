import { Identifier } from "@/id/id"
import { SessionExport } from "../session-export"
import type { Scope } from "@/scope/types"

/**
 * Shared helpers for converting foreign coding-agent session transcripts
 * (Claude Code / Codex JSONL) into a Synergy `SessionExport.Report` so the
 * existing `SessionImport.fromReport()` write path can be reused unchanged.
 *
 * Both transcript formats are internal and can change between tool releases,
 * so every converter is deliberately tolerant: unknown line types and
 * malformed JSON lines are skipped and reported in `ForeignImportStats`
 * instead of failing the whole import.
 */

export interface ForeignImportStats {
  /** Malformed JSON lines that could not be parsed. */
  skippedLines: number
  /** Line types (or payload types) that were not understood. */
  unknownTypes: number
  /** Human-readable notes surfaced to the caller (e.g. missing model). */
  warnings: string[]
}

export interface ForeignMessage {
  id: string
  role: "user" | "assistant"
  created: number
  parentID?: string
  /** Root user-message id; assigned by `linkTurns` before report building. */
  rootID?: string
  parts: ForeignPart[]
}

export type ForeignPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; callID: string; tool: string; input: Record<string, unknown>; output?: string }

export interface ForeignSession {
  id: string
  title: string
  cwd?: string
  created: number
  updated: number
  messages: ForeignMessage[]
}

export const IMPORT_AGENT = "synergy"
export const UNKNOWN_MODEL = { providerID: "unknown", modelID: "unknown" } as const

/** Parse a transcript file into JSON objects, tolerating malformed lines. */
export function parseJsonLines(text: string, stats: ForeignImportStats): unknown[] {
  const entries: unknown[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      stats.skippedLines++
    }
  }
  return entries
}

/** Convert an ISO-8601 timestamp (or epoch ms) to epoch milliseconds. */
export function isoToEpoch(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined
  const ms = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Build a message ID from a foreign UUID, falling back to a generated one. */
export function messageID(uuid?: string): string {
  return uuid ? `msg_${uuid}` : Identifier.ascending("message")
}

/** Build a part ID. */
export function partID(): string {
  return Identifier.ascending("part")
}

/** Build a session ID from a foreign UUID, falling back to a generated one. */
export function sessionID(uuid?: string): string {
  return uuid ? `ses_${uuid}` : Identifier.ascending("session")
}

/**
 * Placeholder scope embedded in the report. `SessionImport.fromReport()`
 * replaces it with the target scope during import. The id `"unknown"` keeps
 * `checkScopeMismatch` from rejecting the report, while `directory` preserves
 * the original working directory for the directory-mismatch warning.
 */
export function placeholderScope(cwd?: string): Scope {
  return { id: "unknown", directory: cwd ?? "" } as Scope
}

function userMessage(input: {
  id: string
  sessionID: string
  created: number
  model?: { providerID: string; modelID: string }
}) {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "user" as const,
    isRoot: true,
    rootID: input.id,
    // Persist the same rendering semantics the normal create path writes
    // (input.ts): the messagePage read path derives `visible` from parts,
    // which are not loaded for non-legacy messages, so an unset value would
    // be derived as `false` and hide the whole timeline.
    visible: true,
    origin: { type: "user" as const },
    includeInContext: true,
    time: { created: input.created },
    agent: IMPORT_AGENT,
    model: input.model ?? UNKNOWN_MODEL,
  }
}

function assistantMessage(input: {
  id: string
  sessionID: string
  created: number
  parentID: string
  rootID: string
  cwd?: string
  model?: { providerID: string; modelID: string }
}) {
  const model = input.model ?? UNKNOWN_MODEL
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant" as const,
    time: { created: input.created, completed: input.created },
    parentID: input.parentID,
    rootID: input.rootID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "build",
    agent: IMPORT_AGENT,
    path: { cwd: input.cwd ?? "", root: input.cwd ?? "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function toMessageV2(
  message: ForeignMessage,
  sessionID: string,
  model?: { providerID: string; modelID: string },
  cwd?: string,
) {
  const parts = message.parts.map(
    (part, index): SessionExport.Report["sessions"][number]["messages"][number]["parts"][number] => {
      if (part.type === "text") {
        return {
          id: partID(),
          sessionID,
          messageID: message.id,
          type: "text" as const,
          text: part.text,
        }
      }
      if (part.type === "reasoning") {
        return {
          id: partID(),
          sessionID,
          messageID: message.id,
          type: "reasoning" as const,
          text: part.text,
          time: { start: message.created },
        }
      }
      const completed = part.output !== undefined
      return {
        id: partID(),
        sessionID,
        messageID: message.id,
        type: "tool" as const,
        callID: part.callID,
        tool: part.tool,
        state: completed
          ? {
              status: "completed" as const,
              input: part.input,
              output: part.output ?? "",
              title: part.tool,
              metadata: {},
              time: { start: message.created, end: message.created },
            }
          : {
              status: "pending" as const,
              input: part.input,
              raw: "",
            },
        metadata: { source: "foreign", order: index },
      }
    },
  )
  const info =
    message.role === "user"
      ? userMessage({ id: message.id, sessionID, created: message.created, model })
      : assistantMessage({
          id: message.id,
          sessionID,
          created: message.created,
          parentID: message.parentID!,
          rootID: message.rootID ?? message.parentID!,
          cwd,
          model,
        })
  return { info, parts }
}

/** Assemble a single-session v1 export report from converted messages. */
export function buildReport(input: {
  source: "claude-code" | "codex"
  session: ForeignSession
  model?: { providerID: string; modelID: string }
}): SessionExport.Report {
  const { session, model } = input
  const messages = session.messages.map((message) => toMessageV2(message, session.id, model, session.cwd))
  return {
    version: 1,
    generatedAt: Date.now(),
    synergyVersion: "import",
    mode: "full",
    rootSessionID: session.id,
    sessions: [
      {
        info: {
          id: session.id,
          scope: placeholderScope(session.cwd),
          title: session.title,
          version: "1",
          time: { created: session.created, updated: session.updated },
          completionNotice: { unread: false, unreadCount: 0, silent: false },
        },
        messages,
        dag: [],
        todos: [],
        diffs: [],
      },
    ],
  }
}

/** Assign user-message ids as roots and every following assistant reply as a child. */
export function linkTurns(messages: ForeignMessage[]): void {
  let lastUserID: string | undefined
  for (const message of messages) {
    if (message.role === "user") {
      lastUserID = message.id
      message.rootID = message.id
    } else if (message.role === "assistant") {
      message.parentID = lastUserID ?? message.id
      message.rootID = lastUserID ?? message.id
    }
  }
}
