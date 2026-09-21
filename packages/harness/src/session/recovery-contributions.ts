import { RuntimeContext } from "../lifecycle/context"
import type { SessionRecovery } from "./recovery"
import type { StatusInfo } from "./types"

export namespace SessionRecoveryContributions {
  export interface Contribution {
    id: string
    scopes?(): Promise<string[]>
    reconcile?(input: {
      scopeID: string
      apply: boolean
      report: SessionRecovery.RuntimeReconcileReport
    }): Promise<void>
    resume?(scopeID?: string): Promise<number>
    statuses?(scopeID: string): Promise<Record<string, StatusInfo>>
  }
  const runtimeState = RuntimeContext.state(() => ({
    contributions: new Map<string, Contribution>(),
  }))
  export function register(contribution: Contribution) {
    const instanceState = runtimeState()

    const existing = instanceState.contributions.get(contribution.id)
    if (existing === contribution) return
    RuntimeContext.assertCompositionOpen("session recovery")
    if (existing) throw new Error(`Session recovery ${contribution.id} is already registered`)
    instanceState.contributions.set(contribution.id, contribution)
  }
  export function list(): readonly Contribution[] {
    const instanceState = runtimeState()

    return [...instanceState.contributions.values()]
  }
}
