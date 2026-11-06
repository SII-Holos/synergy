import { WorkspaceTransfer } from "@ericsanchezok/synergy-harness/session/workspace-transfer"
import type { ScopeTransfer } from "@ericsanchezok/synergy-harness/scope/transfer"

export namespace ChannelWorkspaceTransfer {
  export function record(
    key: string[],
    value: unknown,
    resolve: WorkspaceTransfer.Resolve,
    relocate?: ScopeTransfer.Relocate,
  ): unknown {
    if (key[0] !== "channel") return value
    const managed = key.length === 3 && key[1] === "managed_ownership"
    const github =
      key.length === 8 &&
      key[1] === "providers" &&
      key[2] === "github" &&
      key[3] === "accounts" &&
      key[5] === "workspaces" &&
      key[6] === "index"
    if ((!managed && !github) || !value || typeof value !== "object" || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    const selected =
      github && typeof record.scopeID === "string"
        ? WorkspaceTransfer.selection(
            {
              workspaceID: record.workspaceID,
              workspace:
                typeof record.directory === "string"
                  ? { type: "main", scopeID: record.scopeID, path: record.directory }
                  : null,
            },
            record.scopeID,
            resolve,
          )
        : undefined
    return {
      ...record,
      ...(relocate && typeof record.directory === "string" ? { directory: relocate(record.directory) } : {}),
      ...(selected ? { workspaceID: selected.workspaceID } : {}),
    }
  }
}
