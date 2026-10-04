import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { sharedRequests } from "./shared-requests"

export function worktreeInventoryKey(runtime: string, scopeID: string) {
  return `${runtime}\u0000worktrees\u0000${scopeID}\u0000`
}

export function loadWorktreeInventory(
  client: SynergyClient,
  runtime: string,
  scopeID: string,
  version: string,
  signal: AbortSignal,
) {
  return sharedRequests.request(
    worktreeInventoryKey(runtime, scopeID) + version,
    (underlying) => client.project.worktreeInventory({ scopeID }, { signal: underlying, throwOnError: true }),
    { signal },
  )
}
