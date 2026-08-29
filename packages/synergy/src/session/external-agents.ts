/**
 * S9c source inversion: the L1 session invoke loop drives external-agent
 * adapters (Codex, Claude Code, ...) through this registry instead of
 * importing the external-agent product domain. The L4 product manifest
 * registers the bridge; unregistered access degrades quietly (no adapters,
 * external agents fall back to the adapter-not-found path).
 */
export namespace SessionExternalAgents {
  export interface Adapter {
    name: string
    started: boolean
    capabilities: { modelSwitch: boolean }
    start(options: { cwd: string; config: Record<string, unknown>; env?: Record<string, string> }): Promise<void>
  }

  export interface TurnContext {
    sessionID: string
    prompt: string
    instructions?: string
    taskContext?: string
  }

  export type ApprovalDelegate = (request: unknown) => Promise<boolean>

  export interface ProcessInput {
    sessionID: string
    agent: string
    adapter: Adapter
    parentID: string
    model: { providerID: string; modelID: string }
    context: TurnContext
    approvalDelegate: ApprovalDelegate
    abort: AbortSignal
  }

  export interface Provider {
    getAdapter(name: string, sessionID?: string): Adapter | undefined
    process(input: ProcessInput): Promise<unknown>
  }

  let provider: Provider | undefined

  export function register(value: Provider): void {
    provider = value
  }

  export function get(): Provider | undefined {
    return provider
  }

  export function getAdapter(name: string, sessionID?: string): Adapter | undefined {
    return provider?.getAdapter(name, sessionID)
  }

  export function process(input: ProcessInput): Promise<unknown> | undefined {
    return provider?.process(input)
  }
}
