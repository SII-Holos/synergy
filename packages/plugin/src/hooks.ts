export type HookCategory =
  | "core"
  | "chat"
  | "permission"
  | "tool"
  | "session"
  | "cortex"
  | "agenda"
  | "note"
  | "engram"
  | "experimental"

export interface HookDescriptor {
  name: string
  category: HookCategory
  mutatesOutput: boolean
  summary: string
}

export const HOOKS: HookDescriptor[] = [
  {
    name: "tool",
    category: "core",
    mutatesOutput: false,
    summary: "Register custom runtime-side tools",
  },
  {
    name: "auth",
    category: "core",
    mutatesOutput: false,
    summary: "Add provider auth methods and auth loaders",
  },
  {
    name: "config",
    category: "core",
    mutatesOutput: false,
    summary: "Observe the loaded runtime config",
  },
  {
    name: "event",
    category: "core",
    mutatesOutput: false,
    summary: "Observe runtime bus events",
  },
  {
    name: "chat.message",
    category: "chat",
    mutatesOutput: true,
    summary: "Rewrite incoming user messages before processing",
  },
  {
    name: "chat.params",
    category: "chat",
    mutatesOutput: true,
    summary: "Adjust model parameters before LLM calls",
  },
  {
    name: "permission.ask",
    category: "permission",
    mutatesOutput: true,
    summary: "Override ask, deny, or allow decisions",
  },
  {
    name: "tool.execute.before",
    category: "tool",
    mutatesOutput: true,
    summary: "Rewrite tool args before execution",
  },
  {
    name: "tool.execute.after",
    category: "tool",
    mutatesOutput: true,
    summary: "Rewrite tool output, title, or metadata",
  },
  {
    name: "session.turn.after",
    category: "session",
    mutatesOutput: false,
    summary: "Observe completed assistant turns",
  },
  {
    name: "cortex.task.after",
    category: "cortex",
    mutatesOutput: false,
    summary: "Observe completed Cortex tasks",
  },
  {
    name: "agenda.run.before",
    category: "agenda",
    mutatesOutput: true,
    summary: "Skip or rewrite an agenda run before execution",
  },
  {
    name: "agenda.run.after",
    category: "agenda",
    mutatesOutput: false,
    summary: "Observe successful agenda runs",
  },
  {
    name: "agenda.run.error",
    category: "agenda",
    mutatesOutput: false,
    summary: "Observe failed agenda runs",
  },
  {
    name: "note.create.before",
    category: "note",
    mutatesOutput: true,
    summary: "Rewrite note creation input before persistence",
  },
  {
    name: "note.create.after",
    category: "note",
    mutatesOutput: false,
    summary: "Observe created notes after persistence",
  },
  {
    name: "note.update.before",
    category: "note",
    mutatesOutput: true,
    summary: "Rewrite note patches before update logic runs",
  },
  {
    name: "note.update.after",
    category: "note",
    mutatesOutput: false,
    summary: "Observe updated notes after persistence",
  },
  {
    name: "note.search.before",
    category: "note",
    mutatesOutput: true,
    summary: "Rewrite note search filters before execution",
  },
  {
    name: "note.search.after",
    category: "note",
    mutatesOutput: true,
    summary: "Filter or reorder note search results",
  },
  {
    name: "engram.memory.search.before",
    category: "engram",
    mutatesOutput: true,
    summary: "Rewrite engram memory search query and options",
  },
  {
    name: "engram.memory.search.after",
    category: "engram",
    mutatesOutput: true,
    summary: "Filter or reorder engram memory results",
  },
  {
    name: "engram.experience.encode.after",
    category: "engram",
    mutatesOutput: false,
    summary: "Observe experience encoding outcomes",
  },
  {
    name: "experimental.chat.messages.transform",
    category: "experimental",
    mutatesOutput: true,
    summary: "Rewrite the chat message history sent to the model",
  },
  {
    name: "experimental.chat.system.transform",
    category: "experimental",
    mutatesOutput: true,
    summary: "Rewrite the assembled system prompt",
  },
  {
    name: "experimental.session.compacting",
    category: "experimental",
    mutatesOutput: true,
    summary: "Customize session compaction context or prompt",
  },
  {
    name: "experimental.text.complete",
    category: "experimental",
    mutatesOutput: true,
    summary: "Rewrite text completion output before finalization",
  },
]

/**
 * All runtime bus event names observable via the `core.event` hook.
 * Source of truth: SDK types.gen.ts `Event` discriminated union (types from BusEvent.define() calls).
 */
export const BUS_EVENT_NAMES: string[] = [
  // installation
  "installation.updated",
  "installation.update_available",
  // scope
  "scope.updated",
  "scope.removed",
  // config
  "config.updated",
  "config.set_activated",
  // server
  "server.instance.disposed",
  "server.connected",
  "global.disposed",
  // file
  "file.edited",
  "file.watcher.updated",
  // lsp
  "lsp.updated",
  "lsp.client_diagnostics",
  // mcp
  "mcp.ready",
  "mcp.tools_changed",
  "mcp.prompts_changed",
  "mcp.resources_changed",
  // command
  "command.executed",
  // vcs
  "vcs.branch.updated",
  // permission
  "permission.asked",
  "permission.replied",
  "permission.allow_all_changed",
  // note
  "note.created",
  "note.updated",
  "note.deleted",
  // session
  "session.created",
  "session.updated",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.status",
  "session.idle",
  "session.compacted",
  // question
  "question.asked",
  "question.replied",
  "question.rejected",
  // runtime
  "runtime.reloaded",
  // message
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  // todo
  "todo.updated",
  // dag
  "dag.updated",
  // app
  "app.push",
  // holos profile
  "holos.profile.updated",
  // holos contact
  "holos.contact.added",
  "holos.contact.removed",
  "holos.contact.updated",
  "holos.contact.config_updated",
  // holos friend request
  "holos.friend_request.created",
  "holos.friend_request.updated",
  "holos.friend_request.removed",
  // holos queue
  "holos.queue.enqueued",
  "holos.queue.delivered",
  "holos.queue.expired",
  // holos connection
  "holos.connected",
  "holos.connection_status.changed",
  "holos.presence",
  // agenda
  "agenda.item.created",
  "agenda.item.updated",
  "agenda.item.deleted",
  // cortex
  "cortex.task.created",
  "cortex.task.completed",
  "cortex.tasks.updated",
  // pty
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  // channel
  "channel.command.executed",
  "channel.connected",
  "channel.disconnected",
  "channel.message.received",
]

export const HOOK_CATEGORIES: HookCategory[] = [
  "core",
  "chat",
  "permission",
  "tool",
  "session",
  "cortex",
  "agenda",
  "note",
  "engram",
  "experimental",
]
