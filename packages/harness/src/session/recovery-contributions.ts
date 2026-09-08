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
  const contributions = new Map<string, Contribution>()
  export function register(contribution: Contribution) {
    contributions.set(contribution.id, contribution)
  }
  export function list(): readonly Contribution[] {
    return [...contributions.values()]
  }
}
