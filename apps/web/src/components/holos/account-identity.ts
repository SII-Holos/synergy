import type { HolosState } from "@ericsanchezok/synergy-sdk/client"

export type AccountTone = "muted" | "success" | "active" | "danger"

export interface AccountIdentityLabels {
  product: string
  holosAccount: string
  loading: string
  signedOut: string
  profileUnavailable: string
  connectedToHolos: string
  connecting: string
  failed: string
  disconnected: string
  disabled: string
  unavailable: string
}

export interface AccountIdentity {
  name: string
  description: string
  tone: AccountTone
  agentId?: string
  avatarUrl?: string
}

export function accountAgentID(state: HolosState): string | undefined {
  return state.identity.activeAccount?.agentId ?? state.identity.agentId ?? undefined
}

function connectionLabel(state: HolosState, labels: AccountIdentityLabels): string {
  if (state.connection.status === "connected") return labels.connectedToHolos
  if (state.connection.status === "connecting") return labels.connecting
  if (state.connection.status === "failed") return labels.failed
  if (state.connection.status === "disconnected") return labels.disconnected
  if (state.connection.status === "disabled") return labels.disabled
  return labels.unavailable
}

function connectionTone(input: { loaded: boolean; state: HolosState }): AccountTone {
  if (!input.loaded || !input.state.identity.loggedIn) return "muted"
  if (input.state.connection.status === "connected") return "success"
  if (input.state.connection.status === "connecting") return "active"
  if (input.state.connection.status === "failed" || input.state.connection.status === "disconnected") return "danger"
  return "muted"
}

/**
 * Derives the single account identity shown by every navigation surface (desktop
 * sidebar and mobile drawer). Kept pure so both surfaces cannot drift.
 */
export function resolveAccountIdentity(input: {
  hasHolos: boolean
  loaded: boolean
  state: HolosState
  labels: AccountIdentityLabels
}): AccountIdentity {
  const { hasHolos, loaded, state, labels } = input
  const agentId = accountAgentID(state)
  const profile = state.social.profile

  const name = (() => {
    if (!hasHolos) return "Synergy"
    if (!loaded) return "HOLOS"
    if (state.identity.loggedIn && profile?.name) return profile.name
    if (state.identity.loggedIn && agentId) return `Agent ${agentId.slice(0, 8)}`
    return labels.holosAccount
  })()

  const description = (() => {
    if (!hasHolos) return labels.product
    if (!loaded) return labels.loading
    if (!state.identity.loggedIn) return labels.signedOut
    if (state.social.profileError) return labels.profileUnavailable
    const about = profile?.description?.trim()
    if (about) return about
    return connectionLabel(state, labels)
  })()

  return {
    name,
    description,
    tone: connectionTone({ loaded, state }),
    agentId,
    avatarUrl: hasHolos ? (profile?.avatarUrl ?? undefined) : undefined,
  }
}
