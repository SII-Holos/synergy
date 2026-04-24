import type { Part as PartType, ToolPart } from "@ericsanchezok/synergy-sdk/client"

export const WAITING_TASKS_PHRASES = [
  (name: string, n: number) => `${name} waiting on ${n} background task${n > 1 ? "s" : ""}...`,
  (name: string, n: number) => `${n} task${n > 1 ? "s" : ""} still cooking — ${name} standing by...`,
  (name: string, n: number) => `${name} hanging tight — ${n} task${n > 1 ? "s" : ""} in flight`,
  (name: string, n: number) => `${name} sitting tight — ${n} task${n > 1 ? "s" : ""} running`,
  (name: string, n: number) => `${n} agent${n > 1 ? "s" : ""} at work — ${name} on standby...`,
] as const

export const THINKING_PHRASES = [
  (name: string) => `${name} is cooking...`,
  (name: string) => `${name} putting it together...`,
  (name: string) => `${name} connecting the dots...`,
  (name: string) => `${name} on it...`,
  (name: string) => `${name} brewing something up...`,
  (name: string) => `${name} weaving things together...`,
] as const

export function pickStatusPhrase<T>(phrases: readonly T[], seed: string): T {
  const hash = seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return phrases[hash % phrases.length]!
}

export function titlecaseStatusLabel(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export function computeStatusFromPart(part: PartType | undefined): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    if (part.state.status === "generating") {
      switch (part.tool) {
        case "edit":
        case "write":
        case "multiedit":
        case "patch":
          return "Composing edits"
        default:
          return "Generating input"
      }
    }
    switch (part.tool) {
      case "task":
        return "Delegating work"
      case "todowrite":
      case "todoread":
      case "dagwrite":
      case "dagread":
      case "dagpatch":
        return "Planning next steps"
      case "read":
        return "Gathering context"
      case "list":
      case "grep":
      case "glob":
      case "ast_grep":
        return "Searching the codebase"
      case "webfetch":
      case "websearch":
        return "Searching the web"
      case "edit":
      case "write":
      case "multiedit":
      case "patch":
        return "Making edits"
      case "bash":
      case "process":
        return "Running commands"
      case "look_at":
        return "Analyzing files"
      case "lsp":
        return "Querying language server"
      case "skill":
        return "Loading skill"
      case "arxiv_search":
      case "arxiv_download":
        return "Searching papers"
      case "task_output":
      case "task_cancel":
        return "Managing tasks"
      case "question":
        return "Asking questions"
      case "connect":
        return "Connecting to remote host"
      case "context7_resolve-library-id":
      case "context7_query-docs":
        return "Looking up documentation"
      case "memory_search":
      case "memory_get":
        return "Flashing back"
      case "memory_write":
      case "memory_edit":
        return "Forming memory"
      case "note_list":
      case "note_read":
      case "note_search":
      case "note_write":
        return "Working with notes"
      case "session_list":
      case "session_read":
      case "session_search":
        return "Browsing sessions"
      case "session_send":
        return "Sending message"
      case "agenda_create":
      case "agenda_list":
      case "agenda_update":
      case "agenda_delete":
      case "agenda_trigger":
      case "agenda_logs":
        return "Managing schedule"
      case "agora_search":
      case "agora_read":
        return "Browsing projects"
      case "agora_post":
      case "agora_join":
      case "agora_sync":
      case "agora_submit":
      case "agora_accept":
      case "agora_comment":
        return "Collaborating on Agora"
      case "profile_get":
      case "profile_update":
        return "Updating profile"
      case "email":
        return "Sending email"
      case "attach":
        return "Preparing files"
      case "diagram":
        return "Drawing diagram"
      case "runtime_reload":
        return "Reloading config"
      case "task_list":
        return "Managing tasks"
      case "batch":
        return "Running batch"
      default:
        return undefined
    }
  }

  if (part.type === "reasoning") {
    const text = part.text ?? ""
    const match = text.trimStart().match(/^\*\*(.+?)\*\*/)
    if (match) return `Thinking · ${match[1].trim()}`
    return "Thinking"
  }

  if (part.type === "text") {
    return "Gathering thoughts"
  }

  return undefined
}

export function computeWorkingPhrase(params: { agentName: string; cortexRunning: number; seed: string }): string {
  if (params.cortexRunning > 0) {
    return pickStatusPhrase(WAITING_TASKS_PHRASES, params.seed)(params.agentName, params.cortexRunning)
  }
  return pickStatusPhrase(THINKING_PHRASES, params.seed)(params.agentName)
}

export function extractRunningTaskSessionID(part: ToolPart | undefined): string | undefined {
  if (!part?.state || !("metadata" in part.state)) return undefined
  return part.state.metadata?.sessionId as string | undefined
}

export function computeLatestStatusFromParts(parts: readonly PartType[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    const status = computeStatusFromPart(part)
    if (status) return status
  }
  return undefined
}
