import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyControlClient } from "../src/control/client"
import { MetaSynergyRuntime } from "../src/runtime"

const originalHome = process.env.META_SYNERGY_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-control-test-"))
  tempRoots.push(root)
  process.env.META_SYNERGY_HOME = root
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.META_SYNERGY_HOME
  } else {
    process.env.META_SYNERGY_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("meta-synergy control socket", () => {
  test("exposes runtime control actions over the local socket", async () => {
    const runtime = await MetaSynergyRuntime.create()
    const envID = runtime.host.envID
    if (!envID) throw new Error("Expected runtime envID")
    await runtime.control.start()
    try {
      expect(await MetaSynergyControlClient.isAvailable()).toBe(true)

      const mode = await MetaSynergyControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
      }>({ action: "runtime.mode" })
      expect(mode.mode).toBe("standalone")
      expect(mode.ownership.local.owned).toBe(false)

      const approval = await MetaSynergyControlClient.request<{ mode: string }>({ action: "approval.get" })
      expect(approval.mode).toBe("manual")

      const managed = await MetaSynergyControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
        connectionStatus: string
      }>({ action: "runtime.enter_managed" })
      expect(managed.mode).toBe("managed")
      expect(managed.ownership.local.owned).toBe(true)
      expect(managed.ownership.local.activeOwnerID).toMatch(/^env_/)

      expect(managed.connectionStatus).toBe("disconnected")

      const standalone = await MetaSynergyControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
        connectionStatus: string
      }>({ action: "runtime.set_mode", mode: "standalone" })
      expect(standalone.mode).toBe("standalone")
      expect(standalone.ownership.local.owned).toBe(false)

      const managedAgain = await MetaSynergyControlClient.request<{
        mode: string
        ownership: { local: { owned: boolean; activeOwnerID: string | null } }
        connectionStatus: string
      }>({ action: "runtime.enter_managed" })
      expect(managedAgain.mode).toBe("managed")
      expect(managedAgain.ownership.local.owned).toBe(true)

      await MetaSynergyControlClient.request({ action: "approval.set", mode: "trusted-only" })
      const collaboration = await MetaSynergyControlClient.request<{ enabled: boolean; approvalMode: string }>({
        action: "collaboration.status",
      })
      expect(collaboration.enabled).toBe(true)
      expect(collaboration.approvalMode).toBe("trusted-only")

      const label = await MetaSynergyControlClient.request<{ label: string | null }>({
        action: "label.set",
        label: "local test",
      })
      expect(label.label).toBe("local test")

      const trust = await MetaSynergyControlClient.request<{ agents: string[] }>({
        action: "trust.add",
        subject: "agent",
        value: "agent_test",
      })
      expect(trust.agents).toContain("agent_test")

      const caller = {
        type: "holos",
        agentID: "agent_test",
        ownerUserID: 42,
        profile: { source: "control-socket-test" },
      }

      const opened = await MetaSynergyControlClient.request<{
        version: 1
        requestID: string
        ok: true
        tool: "session"
        action: "open"
        result: {
          title: string
          metadata: {
            action: "open"
            status: string
            sessionID?: string
            remoteAgentID?: string
            remoteOwnerUserID?: number
            label?: string
            backend: "remote"
          }
          output: string
        }
      }>({
        action: "meta.execute",
        caller,
        body: {
          version: 1,
          requestID: "req_open",
          envID,
          tool: "session",
          action: "open",
          payload: {
            action: "open",
            label: "local proxy test",
          },
        },
      })
      expect(opened.ok).toBe(true)
      expect(opened.tool).toBe("session")
      expect(opened.action).toBe("open")
      expect(opened.result.metadata.status).toBe("opened")
      expect(opened.result.metadata.remoteAgentID).toBe("agent_test")
      expect(opened.result.metadata.remoteOwnerUserID).toBe(42)
      expect(opened.result.metadata.label).toBe("local proxy test")
      expect(opened.result.metadata.sessionID).toBeTruthy()

      const listed = await MetaSynergyControlClient.request<{
        version: 1
        requestID: string
        ok: true
        tool: "process"
        action: "list"
        result: {
          title: string
          metadata: {
            action: "list"
            processes?: Array<{ processId: string }>
            hostSessionID: string
            envID: string
            backend: "remote"
          }
          output: string
        }
      }>({
        action: "meta.execute",
        caller,
        body: {
          version: 1,
          requestID: "req_list",
          envID,
          tool: "process",
          action: "list",
          sessionID: opened.result.metadata.sessionID!,
          payload: { action: "list" },
        },
      })
      expect(listed.ok).toBe(true)
      expect(listed.tool).toBe("process")
      expect(listed.action).toBe("list")
      expect(listed.result.metadata.action).toBe("list")
      expect(listed.result.metadata.envID).toBe(envID)
      expect(listed.result.metadata.backend).toBe("remote")
    } finally {
      await runtime.control.stop()
    }
  })
})
