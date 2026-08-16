import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkCLIBackend } from "../src/cli-backend"
import { SynergyLinkStore } from "../src/state/store"
import type { SynergyLinkPendingRequest } from "../src/state/store"

const originalHome = process.env.SYNERGY_LINK_HOME
const originalSynergyHome = process.env.SYNERGY_TEST_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-backend-offline-"))
  const synergyHome = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-backend-auth-"))
  tempRoots.push(root, synergyHome)
  process.env.SYNERGY_LINK_HOME = root
  process.env.SYNERGY_TEST_HOME = synergyHome
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalHome
  if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalSynergyHome
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

const pendingRequest: SynergyLinkPendingRequest = {
  id: "req_1",
  callerAgentID: "agent_a",
  callerOwnerUserID: 7,
  label: "pairing",
  status: "pending",
  requestedAt: Date.now() - 10_000,
  updatedAt: Date.now() - 5_000,
  requestCount: 1,
}

describe("synergy-link cli backend offline surface", () => {
  test("status reports a sanitized last-known snapshot without a control plane", async () => {
    const state = await SynergyLinkStore.loadState()
    state.label = "host-label"
    await SynergyLinkStore.saveState(state)

    const snapshot = (await SynergyLinkCLIBackend.status()) as {
      source: string
      stale: boolean
      controlError: string
      auth: { loggedIn: boolean }
      host: { label: string | null }
      state: { label: string | null }
      service: { running: boolean }
    }
    expect(snapshot.source).toBe("snapshot")
    expect(snapshot.stale).toBe(true)
    expect(snapshot.controlError).toContain("Control socket is unavailable")
    expect(snapshot.auth.loggedIn).toBe(false)
    expect(snapshot.host.label).toBe("host-label")
    expect(snapshot.state.label).toBe("host-label")
    expect(snapshot.service.running).toBe(false)
  })

  test("mode reports persisted runtime mode and ownership while offline", async () => {
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "managed"
    state.ownerRegistry.local.ownerIDs = ["synergy:me"]
    state.ownerRegistry.local.activeOwnerID = "synergy:me"
    state.ownerRegistry.local.leaseExpiresAt = Date.now() + 60_000
    await SynergyLinkStore.saveState(state)

    const mode = (await SynergyLinkCLIBackend.mode()) as {
      mode: string
      ownership: { local: { owned: boolean; activeOwnerID: string | null } }
      service: { running: boolean }
    }
    expect(mode.mode).toBe("managed")
    expect(mode.ownership.local.owned).toBe(true)
    expect(mode.ownership.local.activeOwnerID).toBe("synergy:me")
    expect(mode.service.running).toBe(false)
  })

  test("whoami never exposes stored credentials", async () => {
    const whoami = (await SynergyLinkCLIBackend.whoami()) as {
      auth: { loggedIn: boolean; agentID: string | null; source: string | null }
      mode: string
      linkID: string | null
      label: string | null
      service: { running: boolean }
    }
    expect(whoami.auth.loggedIn).toBe(false)
    expect(whoami.auth.agentID).toBeNull()
    expect(whoami.auth.source).toBeNull()
    expect(whoami.mode).toBe("standalone")
    expect(whoami.linkID).toBeNull()
    expect(whoami.label).toBeNull()
    expect(whoami.service.running).toBe(false)
  })

  test("reconnect explains that the service is offline", async () => {
    const reconnect = await SynergyLinkCLIBackend.reconnect()
    expect(reconnect.requested).toBe(false)
    expect(reconnect.reason).toBe("Service is not running")
    expect(reconnect.service.running).toBe(false)
  })

  test("doctor reports individual checks with default endpoints and no credentials", async () => {
    const doctor = (await SynergyLinkCLIBackend.doctor()) as {
      ok: boolean
      mode: string
      checks: Array<{ name: string; ok: boolean; detail: string }>
      auth: { loggedIn: boolean; agentID: string | null }
      service: { running: boolean }
      state: { label: string | null }
    }
    const byName = Object.fromEntries(doctor.checks.map((check) => [check.name, check]))
    expect(byName.config_dir?.ok).toBe(true)
    expect(byName.config_dir?.detail).toBe(SynergyLinkStore.root())
    expect(byName.mode?.detail).toBe("standalone")
    expect(byName.local_owner?.detail).toBe("Not applicable in standalone mode")
    expect(byName.endpoints?.ok).toBe(true)
    expect(byName.endpoints?.detail).toContain("https://api.holosai.io")
    expect(byName.auth?.ok).toBe(false)
    expect(byName.auth?.detail).toBe("No Holos credentials found")
    expect(byName.service?.ok).toBe(false)
    expect(byName.service?.detail).toBe("Service is not running")
    expect(byName.connection?.ok).toBe(false)
    expect(byName.connection?.detail).toBe("disconnected")
    expect(doctor.ok).toBe(false)
    expect(doctor.auth.loggedIn).toBe(false)
    expect(doctor.service.running).toBe(false)
  })

  test("doctor relaxes auth and connection checks in managed mode", async () => {
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "managed"
    state.connectionStatus = "disconnected"
    await SynergyLinkStore.saveState(state)

    const doctor = (await SynergyLinkCLIBackend.doctor()) as {
      checks: Array<{ name: string; ok: boolean; detail: string }>
    }
    const byName = Object.fromEntries(doctor.checks.map((check) => [check.name, check]))
    expect(byName.auth?.ok).toBe(true)
    expect(byName.auth?.detail).toBe("Managed mode does not require Holos auth")
    expect(byName.connection?.ok).toBe(true)
    expect(byName.local_owner?.ok).toBe(false)
    expect(byName.local_owner?.detail).toBe("No active managed owner lease")
  })

  test("collaboration status and toggles persist while offline", async () => {
    const initial = (await SynergyLinkCLIBackend.collaborationStatus()) as {
      enabled: boolean
      approvalMode: string
      pendingRequestCount: number
      session: unknown
    }
    expect(initial.enabled).toBe(true)
    expect(initial.session).toBeNull()

    const enabled = (await SynergyLinkCLIBackend.setCollaborationEnabled(true)) as { enabled: boolean }
    expect(enabled.enabled).toBe(true)
    const disabled = (await SynergyLinkCLIBackend.setCollaborationEnabled(false)) as { enabled: boolean }
    expect(disabled.enabled).toBe(false)
    expect((await SynergyLinkStore.loadState()).collaborationEnabled).toBe(false)
  })

  test("session status and kick report an idle host while offline", async () => {
    const state = await SynergyLinkStore.loadState()
    state.blockedAgentIDs = ["agent_b"]
    await SynergyLinkStore.saveState(state)

    const status = (await SynergyLinkCLIBackend.sessionStatus()) as {
      session: unknown
      blockedAgentIDs: string[]
      service: { running: boolean }
    }
    expect(status.session).toBeNull()
    expect(status.blockedAgentIDs).toEqual(["agent_b"])
    expect(status.service.running).toBe(false)

    expect(await SynergyLinkCLIBackend.kickSession(false)).toEqual({
      requested: false,
      block: false,
      session: null,
    })
    expect(await SynergyLinkCLIBackend.kickSession(true)).toEqual({
      requested: false,
      block: true,
      session: null,
    })
  })

  test("approval get and set work offline", async () => {
    const initial = await SynergyLinkCLIBackend.getApproval()
    expect(initial.available).toBe(true)
    if (!initial.available) return
    expect(initial.value.mode).toBe("manual")

    for (const mode of ["auto", "trusted-only", "manual"] as const) {
      const result = await SynergyLinkCLIBackend.setApproval(mode)
      expect(result.available).toBe(true)
      if (result.available) expect(result.value.mode).toBe(mode)
      expect((await SynergyLinkStore.loadState()).approvalMode).toBe(mode)
    }
  })

  test("trust lists add and remove agents and users offline", async () => {
    const initial = await SynergyLinkCLIBackend.listTrust()
    expect(initial.available).toBe(true)
    if (!initial.available) return
    expect(initial.value.agents).toEqual([])
    expect(initial.value.users).toEqual([])

    const addAgent = await SynergyLinkCLIBackend.addTrust("agent", "agent_a")
    expect(addAgent.available).toBe(true)
    const addAgentAgain = await SynergyLinkCLIBackend.addTrust("agent", "agent_a")
    expect(addAgentAgain.available).toBe(true)
    const addUser = await SynergyLinkCLIBackend.addTrust("user", "42")
    expect(addUser.available).toBe(true)
    if (!addUser.available) return
    expect(addUser.value.users).toEqual([42])

    const invalidUser = await SynergyLinkCLIBackend.addTrust("user", "not-a-number")
    expect(invalidUser.available).toBe(false)
    if (invalidUser.available) throw new Error("expected invalid user id to be rejected")
    expect(invalidUser.reason).toContain("Invalid user id")

    const removeUser = await SynergyLinkCLIBackend.removeTrust("user", "42")
    expect(removeUser.available).toBe(true)
    const removeAgent = await SynergyLinkCLIBackend.removeTrust("agent", "agent_a")
    expect(removeAgent.available).toBe(true)
    if (!removeAgent.available) return
    expect(removeAgent.value.agents).toEqual([])
  })

  test("requests list, show, approve, and deny reflect persisted state", async () => {
    const state = await SynergyLinkStore.loadState()
    state.pendingRequests = [pendingRequest]
    await SynergyLinkStore.saveState(state)

    const listed = await SynergyLinkCLIBackend.listRequests()
    expect(listed.available).toBe(true)
    if (!listed.available) return
    expect(listed.value.requests).toHaveLength(1)
    expect(listed.value.requests[0]?.status).toBe("pending")

    const shown = await SynergyLinkCLIBackend.showRequest("req_1")
    expect(shown.available).toBe(true)
    if (!shown.available) return
    expect(shown.value.request.callerAgentID).toBe("agent_a")

    const missing = await SynergyLinkCLIBackend.showRequest("req_unknown")
    expect(missing.available).toBe(false)
    if (missing.available) throw new Error("expected unknown request to be rejected")
    expect(missing.reason).toContain("Unknown request")

    const approved = await SynergyLinkCLIBackend.approveRequest("req_1")
    expect(approved.available).toBe(true)
    if (!approved.available) return
    expect(approved.value.request.status).toBe("approved")
    expect(typeof approved.value.request.decidedAt).toBe("number")

    const persistedApproved = await SynergyLinkStore.loadState()
    expect(persistedApproved.pendingRequests[0]?.status).toBe("approved")

    const denied = await SynergyLinkCLIBackend.denyRequest("req_1")
    expect(denied.available).toBe(true)
    if (!denied.available) return
    expect(denied.value.request.status).toBe("denied")

    const approveMissing = await SynergyLinkCLIBackend.approveRequest("req_unknown")
    expect(approveMissing.available).toBe(false)
    const denyMissing = await SynergyLinkCLIBackend.denyRequest("req_unknown")
    expect(denyMissing.available).toBe(false)
  })

  test("labels round-trip through the persisted store", async () => {
    const initial = (await SynergyLinkCLIBackend.getLabel()) as { label: string | null }
    expect(initial.label).toBeNull()

    const set = (await SynergyLinkCLIBackend.setLabel("test host")) as { label: string | null }
    expect(set.label).toBe("test host")
    expect((await SynergyLinkStore.loadState()).label).toBe("test host")

    const cleared = (await SynergyLinkCLIBackend.setLabel(null)) as { label: string | null }
    expect(cleared.label).toBeNull()
    expect((await SynergyLinkStore.loadState()).label).toBeUndefined()
  })

  test("logout stops the offline service and clears standalone auth state", async () => {
    const state = await SynergyLinkStore.loadState()
    state.currentSession = {
      sessionID: "session_1",
      remoteAgentID: "agent_a",
      remoteOwnerUserID: 7,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    await SynergyLinkStore.saveState(state)

    const result = (await SynergyLinkCLIBackend.logout()) as {
      authCleared: boolean
      service: { alreadyStopped: boolean }
    }
    expect(result.authCleared).toBe(true)
    expect(result.service.alreadyStopped).toBe(true)

    const after = await SynergyLinkStore.loadState()
    expect(after.connectionStatus).toBe("disconnected")
    expect(after.currentSession).toBeUndefined()
    expect(after.service.desiredState).toBe("stopped")
    expect(after.service.runtimeStatus).toBe("stopped")
    expect(after.service.pid).toBeUndefined()
  })
})
