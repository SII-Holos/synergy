import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
/**
 * S9c source inversion: the L1 session domain reaches the blueprint product
 * domain (loop store access, loop-status semantics, loop prompt context)
 * through this registry instead of importing it. The L4 product manifest
 * registers the implementation; unregistered access degrades quietly (no
 * loops, every status inactive, no prompt context).
 */
export namespace SessionBlueprintState {
  export type LoopStatus = "armed" | "running" | "auditing" | "completed" | "failed" | "cancelled"

  /** Structural mirror of a persisted loop stop request as carried through
   * recovery patches. */
  export interface LoopStopRequest {
    summary: string
    completed?: string[]
    evidence?: string[]
    remaining?: string[]
    requestedAt: number
    requesterSessionID: string
    requesterMessageID: string
    reviewToolRecoveryAttempts?: number
  }

  /** Narrow structural view of a BlueprintLoop as consumed by session-side
   * state machines. Registered adapters return full loop records. */
  export interface LoopInfo {
    id: string
    noteID: string
    sessionID: string
    auditSessionID?: string
    status: LoopStatus
    source?: string
    stopRequest?: LoopStopRequest
  }

  export interface LoopPatch {
    status: LoopStatus
    error?: string
    auditSessionID?: string | null
    auditTaskID?: string | null
    stopRequest?: LoopStopRequest | null
  }

  export interface Provider {
    get(scopeID: string, loopID: string): Promise<LoopInfo | undefined>
    list(scopeID: string): Promise<LoopInfo[]>
    updateStatus(scopeID: string, loopID: string, patch: LoopPatch): Promise<LoopInfo>
    /** Mirror of the blueprint domain's active-status semantics
     * (armed/running/auditing). */
    isActiveStatus(status: LoopStatus): boolean
    /** Render the <blueprint-loop-context> system block for a bound session. */
    buildLoopContext(input: { loop: LoopInfo; isAuditSession: boolean; agentName: string }): string
  }

  const runtimeState = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
  }))

  export function register(value: Provider): void {
    const instanceState = runtimeState()

    instanceState.provider = value
  }

  export function get(): Provider | undefined {
    const instanceState = runtimeState()

    return instanceState.provider
  }

  export async function getLoop(scopeID: string, loopID: string): Promise<LoopInfo | undefined> {
    const instanceState = runtimeState()

    if (!instanceState.provider) return undefined
    return instanceState.provider.get(scopeID, loopID).catch(() => undefined)
  }

  export async function listLoops(scopeID: string): Promise<LoopInfo[]> {
    const instanceState = runtimeState()

    if (!instanceState.provider) return []
    return instanceState.provider.list(scopeID).catch(() => [])
  }

  export function updateLoopStatus(scopeID: string, loopID: string, patch: LoopPatch): Promise<LoopInfo> | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.updateStatus(scopeID, loopID, patch)
  }

  export function isActiveStatus(status: LoopStatus): boolean {
    const instanceState = runtimeState()

    return instanceState.provider?.isActiveStatus(status) ?? false
  }

  export function buildLoopContext(input: { loop: LoopInfo; isAuditSession: boolean; agentName: string }): string {
    const instanceState = runtimeState()

    return instanceState.provider?.buildLoopContext(input) ?? ""
  }
}
