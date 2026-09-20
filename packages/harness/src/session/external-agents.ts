import { RuntimeContext } from "../lifecycle/context"
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

  const runtimeState = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
  }))

  export function register(value: Provider): void {
    const instanceState = runtimeState()

    if (instanceState.provider === value) return
    RuntimeContext.assertCompositionOpen("session/external-agents")
    if (instanceState.provider && value) throw new Error("session/external-agents is already registered")
    instanceState.provider = value
  }

  export function get(): Provider | undefined {
    const instanceState = runtimeState()

    return instanceState.provider
  }

  export function getAdapter(name: string, sessionID?: string): Adapter | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.getAdapter(name, sessionID)
  }

  export function process(input: ProcessInput): Promise<unknown> | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.process(input)
  }
}
