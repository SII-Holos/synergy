import type { ScopeTransfer } from "@ericsanchezok/synergy-harness/scope/transfer"

export namespace ChannelWorkspaceTransfer {
  export function record(key: string[], value: unknown, relocate: ScopeTransfer.Relocate): unknown {
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
    return typeof record.directory === "string" ? { ...record, directory: relocate(record.directory) } : value
  }
}
