import type { ChannelStatus, HolosAccountMeta } from "@ericsanchezok/synergy-sdk/client"
import type { MessageDescriptor } from "@lingui/core"
import type { ProviderGroup } from "./types"

export function channelAccountVariantKeys(modelRef: string, providers: ProviderGroup[]): string[] {
  const separator = modelRef.indexOf("/")
  if (separator === -1) return []

  const providerID = modelRef.slice(0, separator)
  const modelID = modelRef.slice(separator + 1)
  const provider = providers.find((item) => item.providerId === providerID)
  return provider?.models.find((item) => item.id === modelID)?.variantKeys ?? []
}

export function clarusAccountDisplayName(accountID: string, accounts: readonly HolosAccountMeta[]): string {
  return accounts.find((account) => account.agentId === accountID)?.profile?.name?.trim() || "Holos Agent"
}
export type ChannelAccountAction = "refresh" | "diagnostics"

export function channelAccountActionKey(action: ChannelAccountAction, accountKey: string): string {
  return `${action}:${accountKey}`
}

export function isChannelAccountActionPending(
  pending: ReadonlySet<string>,
  action: ChannelAccountAction,
  accountKey: string,
): boolean {
  return pending.has(channelAccountActionKey(action, accountKey))
}

const runtimeStatusCopy = {
  connected: { id: "settings.channels.status.connected", message: "Connected" },
  connecting: { id: "settings.channels.status.connecting", message: "Connecting…" },
  waitingForTransport: {
    id: "settings.channels.status.waitingForTransport",
    message: "Waiting for transport",
  },
  disconnected: { id: "settings.channels.status.disconnected", message: "Disconnected" },
  disabled: { id: "settings.channels.status.disabled", message: "Disabled" },
  syncing: { id: "settings.channels.status.syncing", message: "Syncing…" },
  failed: { id: "settings.channels.status.failed", message: "Connection failed" },
  unavailable: { id: "settings.channels.status.unavailable", message: "Status unavailable" },
} satisfies Record<string, MessageDescriptor>

export function channelRuntimeStatusLabel(status: ChannelStatus | undefined): MessageDescriptor {
  if (!status) return runtimeStatusCopy.unavailable
  switch (status.status) {
    case "connected":
      return runtimeStatusCopy.connected
    case "connecting":
      return runtimeStatusCopy.connecting
    case "waiting_for_transport":
      return runtimeStatusCopy.waitingForTransport
    case "disconnected":
      return runtimeStatusCopy.disconnected
    case "disabled":
      return runtimeStatusCopy.disabled
    case "syncing":
      return runtimeStatusCopy.syncing
    case "failed":
      return runtimeStatusCopy.failed
  }
}

export function clarusDiagnosticsFilename(): string {
  return "clarus-diagnostics.ndjson"
}
