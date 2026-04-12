import z from "zod"
import { Log } from "@/util/log"

export namespace ExternalAgent {
  const log = Log.create({ service: "external-agent" })

  // ---------------------------------------------------------------------------
  // Wire event types — the unified contract between adapters and the processor
  // ---------------------------------------------------------------------------

  export const BridgeEvent = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text_delta"), text: z.string() }),
    z.object({ type: z.literal("reasoning_delta"), text: z.string() }),
    z.object({
      type: z.literal("tool_start"),
      id: z.string(),
      name: z.string(),
      input: z.string().optional(),
    }),
    z.object({
      type: z.literal("tool_output"),
      id: z.string(),
      output: z.string(),
    }),
    z.object({
      type: z.literal("tool_end"),
      id: z.string(),
      name: z.string(),
      result: z.string().optional(),
      error: z.string().optional(),
    }),
    z.object({
      type: z.literal("approval_request"),
      id: z.string(),
      /** Approval category — adapter-specific (e.g., "command", "file_change", "permissions"). */
      category: z.string(),
      tool: z.string(),
      input: z.string(),
    }),
    z.object({
      type: z.literal("turn_complete"),
      usage: z
        .object({
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          reasoningTokens: z.number().optional(),
        })
        .optional(),
    }),
    z.object({ type: z.literal("error"), message: z.string() }),
  ])
  export type BridgeEvent = z.infer<typeof BridgeEvent>

  // ---------------------------------------------------------------------------
  // Turn context — structured input for a single turn
  // ---------------------------------------------------------------------------

  export interface TurnContext {
    /** The Synergy session ID — used for per-session thread isolation. */
    sessionID: string
    /** The user's current message text. */
    prompt: string
    /** Project-level instruction files (AGENTS.md, etc.), joined. */
    instructions?: string
    /** Cortex execution context when running as a delegated subtask. */
    taskContext?: string
  }

  // ---------------------------------------------------------------------------
  // Approval delegate — lets the processor decide approval outcomes
  // ---------------------------------------------------------------------------

  export interface ApprovalRequest {
    id: string
    category: string
    tool: string
    input: string
  }

  export type ApprovalDelegate = (request: ApprovalRequest) => Promise<boolean>

  // ---------------------------------------------------------------------------
  // Adapter capabilities — each adapter declares what it supports
  // ---------------------------------------------------------------------------

  export interface Capabilities {
    /** Whether the adapter can switch models on an active session. */
    modelSwitch: boolean
    /** Whether the adapter supports interrupting a running turn. */
    interrupt: boolean
  }

  // ---------------------------------------------------------------------------
  // Adapter interface — each external agent implements this
  // ---------------------------------------------------------------------------

  export interface Adapter {
    readonly name: string
    readonly started: boolean
    readonly capabilities: Capabilities

    /** Check whether the external binary is available on this machine. */
    discover(): Promise<{ available: boolean; path?: string; version?: string }>

    /** Spawn or connect to the external agent process. */
    start(opts: StartOptions): Promise<void>

    /** Execute a single turn, yielding streaming events. */
    turn(context: TurnContext, signal?: AbortSignal): AsyncGenerator<BridgeEvent>

    /** Send an approval response back to the external agent. */
    respondApproval?(requestID: string, approved: boolean): Promise<void>

    /** Interrupt the current turn. */
    interrupt(): Promise<void>

    /** Gracefully shut down the external agent process. */
    shutdown(): Promise<void>
  }

  export interface StartOptions {
    cwd: string
    env?: Record<string, string>
    /** Adapter-specific configuration — shape varies per adapter. */
    config?: Record<string, unknown>
  }

  // ---------------------------------------------------------------------------
  // Registration info — what gets injected into the Agent registry
  // ---------------------------------------------------------------------------

  export const Info = z
    .object({
      adapter: z.string(),
      path: z.string().optional(),
      version: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "ExternalAgentInfo" })
  export type Info = z.infer<typeof Info>

  // ---------------------------------------------------------------------------
  // Adapter registry — adapters self-register here
  // ---------------------------------------------------------------------------

  const adapters = new Map<string, () => Adapter>()
  const instances = new Map<string, Adapter>()

  function instanceKey(name: string, sessionID?: string) {
    return sessionID ? `${name}:${sessionID}` : name
  }

  export function register(name: string, factory: () => Adapter) {
    adapters.set(name, factory)
  }

  export function listAdapters(): string[] {
    return [...adapters.keys()]
  }

  export function getAdapter(name: string, sessionID?: string): Adapter | undefined {
    const key = instanceKey(name, sessionID)
    let instance = instances.get(key)
    if (instance) return instance
    const factory = adapters.get(name)
    if (!factory) return undefined
    instance = factory()
    instances.set(key, instance)
    return instance
  }

  export async function shutdownAll(): Promise<void> {
    const tasks = [...instances.entries()].map(async ([name, adapter]) => {
      try {
        await adapter.shutdown()
      } catch (e) {
        log.warn("shutdown failed", { adapter: name, error: String(e) })
      }
    })
    await Promise.allSettled(tasks)
    instances.clear()
  }

  export async function shutdownAdapter(name: string, sessionID?: string): Promise<void> {
    const key = instanceKey(name, sessionID)
    const adapter = instances.get(key)
    if (!adapter) return
    instances.delete(key)
    try {
      await adapter.shutdown()
    } catch (e) {
      log.warn("shutdown failed", { adapter: key, error: String(e) })
    }
  }
}
