import { expect, test } from "bun:test"
import type { HolosState } from "@ericsanchezok/synergy-sdk/client"
import {
  accountAgentID,
  resolveAccountIdentity,
  type AccountIdentityLabels,
} from "../../../src/components/holos/account-identity"

const labels: AccountIdentityLabels = {
  product: "Product",
  holosAccount: "Account",
  loading: "Loading",
  signedOut: "Signed out",
  profileUnavailable: "Profile unavailable",
  connectedToHolos: "Connected",
  connecting: "Connecting",
  failed: "Failed",
  disconnected: "Disconnected",
  disabled: "Disabled",
  unavailable: "Unavailable",
}

const state = (): HolosState => ({
  identity: { loggedIn: false, agentId: null, activeAccount: null, accounts: [] },
  connection: { status: "unknown" },
  readiness: { ready: false },
  social: { profile: null, contacts: [], presence: {} },
})

test("unavailable, loading and signed-out accounts have distinct navigation identities", () => {
  const input = { state: state(), labels, loaded: true, hasHolos: true }
  expect(resolveAccountIdentity({ ...input, hasHolos: false })).toMatchObject({
    name: "Synergy",
    description: "Product",
    tone: "muted",
    avatarUrl: undefined,
  })
  expect(resolveAccountIdentity({ ...input, loaded: false })).toMatchObject({
    name: "HOLOS",
    description: "Loading",
    tone: "muted",
  })
  expect(resolveAccountIdentity(input)).toMatchObject({ name: "Account", description: "Signed out", tone: "muted" })
})

test("the active account owns the fallback identity and a loaded profile supplies its display fields", () => {
  const current = state()
  current.identity = {
    loggedIn: true,
    agentId: "previous-agent",
    activeAccount: { agentId: "selected-agent", createdAt: 1, updatedAt: 2 },
    accounts: [],
  }
  const input = { state: current, labels, loaded: true, hasHolos: true }
  expect(accountAgentID(current)).toBe("selected-agent")
  expect(resolveAccountIdentity(input)).toMatchObject({ name: "Agent selected", agentId: "selected-agent" })
  current.social.profile = {
    name: "Research account",
    description: "  Project work  ",
    avatarUrl: "https://example.test/avatar.png",
  }
  expect(resolveAccountIdentity(input)).toMatchObject({
    name: "Research account",
    description: "Project work",
    avatarUrl: "https://example.test/avatar.png",
  })
  current.social.profileError = "private diagnostic"
  expect(resolveAccountIdentity(input).description).toBe("Profile unavailable")
  current.identity.activeAccount = null
  expect(accountAgentID(current)).toBe("previous-agent")
  current.identity.agentId = null
  expect(accountAgentID(current)).toBeUndefined()
})

test.each([
  ["connected", "Connected", "success"],
  ["connecting", "Connecting", "active"],
  ["failed", "Failed", "danger"],
  ["disconnected", "Disconnected", "danger"],
  ["disabled", "Disabled", "muted"],
  ["unknown", "Unavailable", "muted"],
] as const)("%s status is visible only after account identity has loaded", (status, description, tone) => {
  const current = state()
  current.identity.loggedIn = true
  current.connection.status = status
  current.social.profile = { name: "Account", description: "   ", avatarUrl: null }
  const input = { state: current, labels, loaded: true, hasHolos: true }
  expect(resolveAccountIdentity(input)).toMatchObject({ description, tone })
  expect(resolveAccountIdentity({ ...input, loaded: false })).toMatchObject({ description: "Loading", tone: "muted" })
  current.identity.loggedIn = false
  expect(resolveAccountIdentity(input)).toMatchObject({ description: "Signed out", tone: "muted" })
})
