import type { I18n, MessageDescriptor } from "@lingui/core"
import type { Part as PartType, ToolPart, SessionStatus, SessionActivity } from "@ericsanchezok/synergy-sdk/client"
import { TOOL_TITLE_DESC } from "./tool-title-descriptors"

// ── Descriptor helpers ──────────────────────────────────────────────

function defineDescriptor(id: string, message: string): MessageDescriptor {
  return { id, message }
}

/** Resolve a descriptor through i18n when available, otherwise return the English default. */
function resolveMsg(i18n: I18n | undefined, desc: MessageDescriptor, values?: Record<string, unknown>): string {
  if (i18n) return i18n._({ ...desc, values })
  return formatDefaultMsg(desc.message!, values)
}
const PLURAL_FALLBACK_LOCALE = "en"

/** Minimal ICU formatter for the default-English path. Handles {key} and {count, plural, ...}. */
function formatDefaultMsg(template: string, values?: Record<string, unknown>): string {
  if (!values) return template
  return template.replace(/\{(\w+)(, plural, (.+?))?\}/g, (_full, key: string, _, pluralSpec: string | undefined) => {
    if (pluralSpec) {
      const val = values[key] as number
      const opts = parsePluralOptions(pluralSpec)
      const rule = new Intl.PluralRules(PLURAL_FALLBACK_LOCALE).select(val - (opts.offset ?? 0))
      const match = opts[rule] ?? opts.other
      return match ? match.replace(/#/g, String(val)) : String(val)
    }
    return String(values[key] ?? `{${key}}`)
  })
}

function parsePluralOptions(spec: string): Record<string, string> & { offset?: number } {
  const opts: Record<string, string> & { offset?: number } = {}
  const parts = spec.split(/\s+(?=one |other |few |many |zero |two |offset )/)
  for (const part of parts) {
    const eq = part.indexOf(" ")
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k === "offset") opts.offset = Number(v)
    else opts[k] = v.slice(1, -1) // strip { }
  }
  return opts
}

// ── Tool-status descriptor tables ───────────────────────────────────

const TOOL_GEN_EDIT_DESC = defineDescriptor("session-status.composing-edits", "Composing edits")
const TOOL_GEN_DEFAULT_DESC = defineDescriptor("session-status.generating-input", "Generating input")

const TOOL_DESC: Record<string, MessageDescriptor> = {
  task: defineDescriptor("session-status.delegating-work", "Delegating work"),

  todowrite: defineDescriptor("session-status.planning-next-steps", "Planning next steps"),
  todoread: defineDescriptor("session-status.planning-next-steps", "Planning next steps"),
  dagwrite: defineDescriptor("session-status.planning-next-steps", "Planning next steps"),
  dagread: defineDescriptor("session-status.planning-next-steps", "Planning next steps"),
  dagpatch: defineDescriptor("session-status.planning-next-steps", "Planning next steps"),

  read: defineDescriptor("session-status.gathering-context", "Gathering context"),

  list: defineDescriptor("session-status.searching-codebase", "Searching the codebase"),
  grep: defineDescriptor("session-status.searching-codebase", "Searching the codebase"),
  glob: defineDescriptor("session-status.searching-codebase", "Searching the codebase"),
  ast_grep: defineDescriptor("session-status.searching-codebase", "Searching the codebase"),

  webfetch: defineDescriptor("session-status.searching-web", "Searching the web"),

  edit: defineDescriptor("session-status.making-edits", "Making edits"),
  write: defineDescriptor("session-status.making-edits", "Making edits"),
  multiedit: defineDescriptor("session-status.making-edits", "Making edits"),
  patch: defineDescriptor("session-status.making-edits", "Making edits"),

  bash: defineDescriptor("session-status.running-commands", "Running commands"),
  process: defineDescriptor("session-status.running-commands", "Running commands"),

  look_at: defineDescriptor("session-status.analyzing-files", "Analyzing files"),

  lsp: defineDescriptor("session-status.querying-language-server", "Querying language server"),

  skill: defineDescriptor("session-status.loading-skill", "Loading skill"),

  task_output: defineDescriptor("session-status.managing-tasks", "Managing tasks"),
  task_cancel: defineDescriptor("session-status.managing-tasks", "Managing tasks"),

  question: defineDescriptor("session-status.asking-questions", "Asking questions"),

  connect: defineDescriptor("session-status.connecting-to-remote-host", "Connecting to remote host"),

  "context7_resolve-library-id": defineDescriptor(
    "session-status.looking-up-documentation",
    "Looking up documentation",
  ),
  "context7_query-docs": defineDescriptor("session-status.looking-up-documentation", "Looking up documentation"),

  memory_search: defineDescriptor("session-status.flashing-back", "Flashing back"),
  memory_get: defineDescriptor("session-status.flashing-back", "Flashing back"),

  memory_write: defineDescriptor("session-status.forming-memory", "Forming memory"),
  memory_edit: defineDescriptor("session-status.forming-memory", "Forming memory"),

  note_list: defineDescriptor("session-status.working-with-notes", "Working with notes"),
  note_read: defineDescriptor("session-status.working-with-notes", "Working with notes"),
  note_search: defineDescriptor("session-status.working-with-notes", "Working with notes"),
  note_write: defineDescriptor("session-status.working-with-notes", "Working with notes"),

  blueprint_loop_stop: defineDescriptor("session-status.reviewing-blueprint", "Reviewing Blueprint"),

  blueprint_loop_approve: defineDescriptor("session-status.working-with-blueprint", "Working with Blueprint"),
  blueprint_loop_reject: defineDescriptor("session-status.working-with-blueprint", "Working with Blueprint"),

  light_loop_approve: defineDescriptor("session-status.reviewing-light-loop", "Reviewing Light Loop"),
  light_loop_reject: defineDescriptor("session-status.reviewing-light-loop", "Reviewing Light Loop"),

  session_list: defineDescriptor("session-status.browsing-sessions", "Browsing sessions"),
  scope_list: defineDescriptor("session-status.browsing-sessions", "Browsing sessions"),
  session_read: defineDescriptor("session-status.browsing-sessions", "Browsing sessions"),
  session_search: defineDescriptor("session-status.browsing-sessions", "Browsing sessions"),

  session_send: defineDescriptor("session-status.sending-message", "Sending message"),

  agenda_create: defineDescriptor("session-status.managing-schedule", "Managing schedule"),
  agenda_list: defineDescriptor("session-status.managing-schedule", "Managing schedule"),
  agenda_update: defineDescriptor("session-status.managing-schedule", "Managing schedule"),
  agenda_delete: defineDescriptor("session-status.managing-schedule", "Managing schedule"),
  agenda_trigger: defineDescriptor("session-status.managing-schedule", "Managing schedule"),
  agenda_logs: defineDescriptor("session-status.managing-schedule", "Managing schedule"),

  profile_get: defineDescriptor("session-status.updating-profile", "Updating profile"),
  profile_update: defineDescriptor("session-status.updating-profile", "Updating profile"),

  email_send: defineDescriptor("session-status.sending-email", "Sending email"),
  email_read: defineDescriptor("session-status.reading-email", "Reading email"),

  attach: defineDescriptor("session-status.preparing-files", "Preparing files"),

  render: defineDescriptor("session-status.rendering-content", "Rendering content"),

  runtime_reload: defineDescriptor("session-status.reloading-config", "Reloading config"),

  task_list: defineDescriptor("session-status.managing-tasks", "Managing tasks"),
}

const REASONING_DESC = defineDescriptor("session-status.thinking", "Thinking")
const REASONING_LABEL_DESC = defineDescriptor("session-status.thinking-label", "Thinking · {label}")
const TEXT_DESC = defineDescriptor("session-status.gathering-thoughts", "Gathering thoughts")

export function computeStatusFromPart(part: PartType | undefined, i18n?: I18n): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    if (part.state.status === "generating") {
      const isEdit = part.tool === "edit" || part.tool === "write" || part.tool === "multiedit" || part.tool === "patch"
      const desc = isEdit ? TOOL_GEN_EDIT_DESC : TOOL_GEN_DEFAULT_DESC
      return resolveMsg(i18n, desc)
    }
    const desc = TOOL_DESC[part.tool]
    if (!desc) return undefined
    return resolveMsg(i18n, desc)
  }

  if (part.type === "reasoning") {
    const text = part.text ?? ""
    const match = text.trimStart().match(/^\*\*(.+?)\*\*/)
    if (match) return resolveMsg(i18n, REASONING_LABEL_DESC, { label: match[1].trim() })
    return resolveMsg(i18n, REASONING_DESC)
  }

  if (part.type === "text") {
    return resolveMsg(i18n, TEXT_DESC)
  }

  return undefined
}

export function extractRunningTaskSessionID(part: ToolPart | undefined): string | undefined {
  if (!part?.state || !("metadata" in part.state)) return undefined
  return part.state.metadata?.sessionId as string | undefined
}

export function computeLatestStatusFromParts(parts: readonly PartType[], i18n?: I18n): string | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    const status = computeStatusFromPart(part, i18n)
    if (status) return status
  }
  return undefined
}

const ACTIVITY_DESC = {
  checking_submission: defineDescriptor("session.activity.checkingSubmission", "Checking submission"),
  preparing_session: defineDescriptor("session.activity.preparingSession", "Preparing session"),
  preparing_workspace: defineDescriptor("session.activity.preparingWorkspace", "Preparing workspace"),
  submitting_input: defineDescriptor("session.activity.submittingInput", "Submitting message"),
  checking_receipt: defineDescriptor("session.activity.checkingReceipt", "Confirming message receipt"),
  reconnecting: defineDescriptor("session.activity.reconnecting", "Reconnecting"),
  queued_storage: defineDescriptor("session.activity.queuedStorage", "Waiting to save message"),
  retrying_input: defineDescriptor("session.activity.retryingInput", "Waiting to retry preparation"),
  materializing_input: defineDescriptor("session.activity.materializingInput", "Preparing execution"),
  preparing_files: defineDescriptor("session.activity.preparingFiles", "Preparing project files"),
  preparing_context: defineDescriptor("session.activity.preparingContext", "Preparing context"),
  queued_agent: defineDescriptor("session.activity.queuedAgent", "Waiting for execution resources"),
  waiting_model: defineDescriptor("session.activity.waitingModel", "Waiting for model response"),
  responding: defineDescriptor("session.activity.responding", "Generating response"),
  queued_tools: defineDescriptor("session.activity.queuedTools", "Waiting for tool execution"),
  running_tools: defineDescriptor("session.activity.runningTools", "Calling tools"),
  waiting_background: defineDescriptor("session.activity.waitingBackground", "Waiting for background tasks"),
  finalizing: defineDescriptor("session.activity.finalizing", "Finalizing results"),
  stopping: defineDescriptor("session.activity.stopping", "Stopping"),
} satisfies Record<SessionActivity["phase"], MessageDescriptor>

export function sessionActivityLabel(
  status: SessionStatus | undefined,
  i18n?: I18n,
  context?: { rootID?: string; approval?: boolean; question?: boolean },
): string {
  const activity = status?.type === "busy" ? status.activity : undefined
  const current = !context?.rootID || !activity?.rootID || activity.rootID === context.rootID
  if (current && activity?.phase === "stopping") return resolveMsg(i18n, ACTIVITY_DESC.stopping)
  if (context?.approval)
    return resolveMsg(i18n, defineDescriptor("session.activity.approval", "Waiting for your approval"))
  if (context?.question)
    return resolveMsg(i18n, defineDescriptor("session.activity.question", "Waiting for your answer"))
  if (status?.type === "retry")
    return resolveMsg(i18n, defineDescriptor("session.activity.retry", "Waiting to retry · attempt {attempt}"), {
      attempt: status.attempt,
    })
  if (!current || !activity) return resolveMsg(i18n, defineDescriptor("session.activity.processing", "Processing task"))
  if (activity.phase === "preparing_workspace" && activity.workspaceOperation) {
    const actions = {
      create: defineDescriptor("session.activity.createWorktree", "Preparing workspace · create worktree"),
      bind: defineDescriptor("session.activity.bindWorktree", "Preparing workspace · bind worktree"),
      enter: defineDescriptor("session.activity.enterWorktree", "Preparing workspace · enter worktree"),
      leave: defineDescriptor("session.activity.leaveWorktree", "Preparing workspace · return to project"),
    }
    return resolveMsg(i18n, actions[activity.workspaceOperation])
  }
  if (activity.phase === "running_tools") {
    if (activity.tool && activity.tool.count > 1)
      return resolveMsg(i18n, defineDescriptor("session.activity.parallelTools", "Calling tools · {count} active"), {
        count: activity.tool.count,
      })
    const tool = activity.tool?.id && TOOL_TITLE_DESC[activity.tool.id]
    if (tool)
      return resolveMsg(i18n, defineDescriptor("session.activity.tool", "Calling tool · {action}"), {
        action: resolveMsg(i18n, tool),
      })
  }
  return resolveMsg(i18n, ACTIVITY_DESC[activity.phase])
}
