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
