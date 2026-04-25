import type {
  AgendaItem,
  AgendaRunLog,
  CortexTask,
  Event,
  createSynergyClient,
  MemoryCategory,
  MemoryRecallMode,
  MemorySearchResult,
  Model,
  NoteCreateInput,
  NoteInfo,
  NotePatchInput,
  Provider,
  PermissionRequest,
  UserMessage,
  Message,
  Part,
  Auth,
  Config,
} from "@ericsanchezok/synergy-sdk"

import type { BunShell } from "./shell"
import type { ToolDefinition, ToolResult } from "./tool"

export * from "./tool"
export type { ToolResult }

// ---------------------------------------------------------------------------
// Plugin Config / Auth / Cache accessors
// ---------------------------------------------------------------------------

export interface PluginConfigAccessor {
  /** Get the plugin's full config object */
  get(): Promise<Record<string, any>>
  /** Set one or more config values (deep-merged into the plugin's namespace) */
  set(values: Record<string, any>): Promise<void>
}

export interface PluginAuthStore {
  /** Read a credential by key */
  get(key: string): Promise<string | undefined>
  /** Persist a credential (encrypted at rest) */
  set(key: string, value: string): Promise<void>
  /** Remove a credential */
  delete(key: string): Promise<void>
  /** Check if a credential exists */
  has(key: string): Promise<boolean>
}

export interface PluginCacheStore {
  /** Read a cached value */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Write a cached value with optional TTL in milliseconds */
  set(key: string, value: unknown, ttl?: number): Promise<void>
  /** Remove a cached value */
  delete(key: string): Promise<void>
  /** Absolute path to this plugin's cache directory */
  directory: string
}

// ---------------------------------------------------------------------------
// Plugin CLI
// ---------------------------------------------------------------------------

export interface PluginCLICommand {
  description: string
  options?: Record<string, { type: "string" | "boolean" | "number"; description?: string; required?: boolean }>
  execute(args: Record<string, any>): Promise<string | void>
}

export interface PluginCLIGroup {
  description: string
  subcommands: Record<string, PluginCLICommand>
}

export type PluginCLIEntry = PluginCLICommand | PluginCLIGroup

// ---------------------------------------------------------------------------
// Plugin Skill
// ---------------------------------------------------------------------------

export interface PluginSkill {
  name: string
  description: string
  /** Skill main content (markdown). When `dir` is set, this overrides auto-loaded content. */
  content?: string
  /** Reference docs: key = reference name, value = inline content string */
  references?: Record<string, string>
  /**
   * Relative path (from pluginDir) to a skill directory on disk.
   * When set, the runtime resolves content, references, and scripts from this directory
   * using the same conventions as `.synergy/skills/` directories:
   *   - `SKILL.md` or `content.txt` → content
   *   - `references/*`              → references (keyed by relative path)
   *   - `scripts/*`                 → scripts (keyed by basename without extension)
   *
   * Explicit `content` or `references` fields take precedence over auto-loaded values.
   */
  dir?: string
}

// ---------------------------------------------------------------------------
// Plugin Agent
// ---------------------------------------------------------------------------

export interface PluginAgent {
  name: string
  /** Description shown to the orchestrator for routing decisions */
  description: string
  /** System prompt */
  prompt: string
  /** Agent mode (default: "all") */
  mode?: "subagent" | "primary" | "all"
  /** Model override in "providerID/modelID" format */
  model?: string
  temperature?: number
  topP?: number
  /** Maximum agentic iterations */
  steps?: number
  /** Hide from the @ autocomplete menu */
  hidden?: boolean
  /** Hex color code (e.g. "#FF5733") */
  color?: string
  /** Permission rules — same format as synergy.jsonc agent.permission */
  permission?: Record<string, any>
}

// ---------------------------------------------------------------------------
// Provider auth (unchanged)
// ---------------------------------------------------------------------------

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOuathResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
)

// ---------------------------------------------------------------------------
// PluginInput — context provided to every plugin's init()
// ---------------------------------------------------------------------------

export type PluginInput = {
  client: ReturnType<typeof createSynergyClient>
  scope: {
    type: "global" | "project"
    id: string
    directory: string
    worktree: string
    vcs?: "git"
    name?: string
    icon?: { url?: string; color?: string }
    sandboxes?: string[]
    time?: { created: number; updated: number; initialized?: number }
  }
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
  config: PluginConfigAccessor
  auth: PluginAuthStore
  cache: PluginCacheStore
  /** Absolute path to this plugin's package root (where package.json lives) */
  pluginDir: string
}

// ---------------------------------------------------------------------------
// Plugin — the top-level descriptor exported by a plugin package
// ---------------------------------------------------------------------------

export interface Plugin {
  /** Unique identifier for this plugin (used as config/auth/cache namespace) */
  id: string
  /** Human-readable display name */
  name?: string
  /** Initialize the plugin and return hooks */
  init(input: PluginInput): Promise<PluginHooks>
}

// ---------------------------------------------------------------------------
// PluginHooks — what init() returns
// ---------------------------------------------------------------------------

export interface PluginHooks {
  /** Called when the plugin is being unloaded (e.g. runtime reload) */
  dispose?(): Promise<void>
  /** Register CLI commands under `synergy <pluginId> ...` */
  cli?: Record<string, PluginCLIEntry>
  /** Register skills that become available when this plugin is loaded */
  skills?: PluginSkill[]
  /** Register custom agents */
  agents?: Record<string, PluginAgent>
  /** Register custom tools */
  tool?: Record<string, ToolDefinition>
  /** Provider auth integration */
  auth?: AuthHook
  /** Observe runtime bus events */
  event?(input: { event: Event }): Promise<void>
  /** Observe the loaded runtime config */
  config?(input: Config): Promise<void>
  /** Rewrite incoming user messages */
  "chat.message"?(
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ): Promise<void>
  /** Modify LLM parameters */
  "chat.params"?(
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { temperature: number; topP: number; topK: number; options: Record<string, any> },
  ): Promise<void>
  /** Override permission decisions */
  "permission.ask"?(input: PermissionRequest, output: { status: "ask" | "deny" | "allow" }): Promise<void>
  /** Rewrite tool args before execution */
  "tool.execute.before"?(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ): Promise<void>
  /** Rewrite tool output after execution */
  "tool.execute.after"?(
    input: { tool: string; sessionID: string; callID: string },
    output: { title: string; output: string; metadata: any },
  ): Promise<void>
  /** Rewrite chat message history sent to model */
  "experimental.chat.messages.transform"?(
    input: {},
    output: { messages: { info: Message; parts: Part[] }[] },
  ): Promise<void>
  /** Rewrite the assembled system prompt */
  "experimental.chat.system.transform"?(input: {}, output: { system: string[] }): Promise<void>
  /** Customize session compaction */
  "experimental.session.compacting"?(
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ): Promise<void>
  /** Rewrite text completion output */
  "experimental.text.complete"?(
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ): Promise<void>
  /** Observe completed assistant turns */
  "session.turn.after"?(
    input: {
      sessionID: string
      userMessageID: string
      assistantMessageID: string
      assistant: Message
      finish?: string
      error?: unknown
    },
    output: {},
  ): Promise<void>
  /** Observe completed Cortex tasks */
  "cortex.task.after"?(input: { task: CortexTask }, output: {}): Promise<void>
  /** Skip or rewrite agenda run */
  "agenda.run.before"?(
    input: {
      signal: { type: string; source: string; payload?: Record<string, unknown>; timestamp: number }
      item: AgendaItem
      scopeID: string
    },
    output: { skip: boolean; item: AgendaItem },
  ): Promise<void>
  /** Observe successful agenda runs */
  "agenda.run.after"?(
    input: {
      signal: { type: string; source: string; payload?: Record<string, unknown>; timestamp: number }
      item: AgendaItem
      run: AgendaRunLog
      scopeID: string
    },
    output: {},
  ): Promise<void>
  /** Observe failed agenda runs */
  "agenda.run.error"?(
    input: {
      signal: { type: string; source: string; payload?: Record<string, unknown>; timestamp: number }
      item: AgendaItem
      scopeID: string
      error: string
      sessionID?: string
    },
    output: {},
  ): Promise<void>
  /** Rewrite note creation input */
  "note.create.before"?(input: { scopeID: string }, output: { note: NoteCreateInput }): Promise<void>
  /** Observe created notes */
  "note.create.after"?(input: { scopeID: string; noteID: string }, output: { note: NoteInfo }): Promise<void>
  /** Rewrite note update patches */
  "note.update.before"?(
    input: { scopeID: string; noteID: string; current: NoteInfo },
    output: { patch: NotePatchInput },
  ): Promise<void>
  /** Observe updated notes */
  "note.update.after"?(input: { scopeID: string; noteID: string }, output: { note: NoteInfo }): Promise<void>
  /** Rewrite note search filters */
  "note.search.before"?(
    input: { scopeID: string },
    output: {
      pattern: string
      scope: "current" | "global" | "all"
      since?: string
      before?: string
      tags?: string[]
      pinned?: boolean
    },
  ): Promise<void>
  /** Filter or reorder note search results */
  "note.search.after"?(input: { scopeID: string; pattern: string }, output: { notes: NoteInfo[] }): Promise<void>
  /** Rewrite memory search query */
  "engram.memory.search.before"?(
    input: {},
    output: {
      query: string
      vector?: number[]
      topK?: number
      categories?: MemoryCategory[]
      recallModes?: MemoryRecallMode[]
      rerank?: boolean
    },
  ): Promise<void>
  /** Filter or reorder memory results */
  "engram.memory.search.after"?(
    input: { query: string; topK: number },
    output: { results: MemorySearchResult[] },
  ): Promise<void>
  /** Observe experience encoding outcomes */
  "engram.experience.encode.after"?(
    input: { sessionID: string; userMessageID: string },
    output: { encoded: boolean; skipped: boolean; duplicateOf?: string; experienceID?: string },
  ): Promise<void>
}
