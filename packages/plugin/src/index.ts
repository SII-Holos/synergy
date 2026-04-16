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
import { type ToolDefinition } from "./tool"

export * from "./tool"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

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
}

export type Plugin = (input: PluginInput) => Promise<Hooks>

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

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { temperature: number; topP: number; topK: number; options: Record<string, any> },
  ) => Promise<void>
  "permission.ask"?: (input: PermissionRequest, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: {},
    output: {
      system: string[]
    },
  ) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  "session.turn.after"?: (
    input: {
      sessionID: string
      userMessageID: string
      assistantMessageID: string
      assistant: Message
      finish?: string
      error?: unknown
    },
    output: {},
  ) => Promise<void>
  "cortex.task.after"?: (
    input: {
      task: CortexTask
    },
    output: {},
  ) => Promise<void>
  "agenda.run.before"?: (
    input: {
      signal: {
        type: string
        source: string
        payload?: Record<string, unknown>
        timestamp: number
      }
      item: AgendaItem
      scopeID: string
    },
    output: {
      skip: boolean
      item: AgendaItem
    },
  ) => Promise<void>
  "agenda.run.after"?: (
    input: {
      signal: {
        type: string
        source: string
        payload?: Record<string, unknown>
        timestamp: number
      }
      item: AgendaItem
      run: AgendaRunLog
      scopeID: string
    },
    output: {},
  ) => Promise<void>
  "agenda.run.error"?: (
    input: {
      signal: {
        type: string
        source: string
        payload?: Record<string, unknown>
        timestamp: number
      }
      item: AgendaItem
      scopeID: string
      error: string
      sessionID?: string
    },
    output: {},
  ) => Promise<void>
  "note.create.before"?: (
    input: {
      scopeID: string
    },
    output: {
      note: NoteCreateInput
    },
  ) => Promise<void>
  "note.create.after"?: (
    input: {
      scopeID: string
      noteID: string
    },
    output: {
      note: NoteInfo
    },
  ) => Promise<void>
  "note.update.before"?: (
    input: {
      scopeID: string
      noteID: string
      current: NoteInfo
    },
    output: {
      patch: NotePatchInput
    },
  ) => Promise<void>
  "note.update.after"?: (
    input: {
      scopeID: string
      noteID: string
    },
    output: {
      note: NoteInfo
    },
  ) => Promise<void>
  "note.search.before"?: (
    input: {
      scopeID: string
    },
    output: {
      pattern: string
      scope: "current" | "global" | "all"
      since?: string
      before?: string
      tags?: string[]
      pinned?: boolean
    },
  ) => Promise<void>
  "note.search.after"?: (
    input: {
      scopeID: string
      pattern: string
    },
    output: {
      notes: NoteInfo[]
    },
  ) => Promise<void>
  "engram.memory.search.before"?: (
    input: {},
    output: {
      query: string
      vector?: number[]
      topK?: number
      categories?: MemoryCategory[]
      recallModes?: MemoryRecallMode[]
      rerank?: boolean
    },
  ) => Promise<void>
  "engram.memory.search.after"?: (
    input: {
      query: string
      topK: number
    },
    output: {
      results: MemorySearchResult[]
    },
  ) => Promise<void>
  "engram.experience.encode.after"?: (
    input: {
      sessionID: string
      userMessageID: string
    },
    output: {
      encoded: boolean
      skipped: boolean
      duplicateOf?: string
      experienceID?: string
    },
  ) => Promise<void>
}
