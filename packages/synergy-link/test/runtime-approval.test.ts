import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkCLIBackend } from "../src/cli-backend"
import { SynergyLinkRuntime } from "../src/runtime"
import { SynergyLinkLog } from "../src/log"

const originalHome = process.env.SYNERGY_LINK_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-test-"))
  tempRoots.push(root)
  process.env.SYNERGY_LINK_HOME = root
})

afterAll(async () => {
  await SynergyLinkLog.flush()
  if (originalHome === undefined) {
    delete process.env.SYNERGY_LINK_HOME
  } else {
    process.env.SYNERGY_LINK_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link runtime approval", () => {
  test("manual mode queues requests until CLI approval", async () => {
    const runtime = await SynergyLinkRuntime.create()

    const first = await runtime.decideSessionOpen({
      caller: { agentID: "agent_a", ownerUserID: 1 },
      label: "hello",
    })
    expect(first).toBe("pending")

    const listed = await SynergyLinkCLIBackend.listRequests()
    expect(listed.available).toBe(true)
    if (!listed.available) return
    expect(listed.value.requests).toHaveLength(1)
    expect(listed.value.requests[0]?.status).toBe("pending")

    const approved = await runtime.approveRequest(listed.value.requests[0]!.id)
    expect(approved.request.status).toBe("approved")

    const second = await runtime.decideSessionOpen({
      caller: { agentID: "agent_a", ownerUserID: 1 },
      label: "hello again",
    })
    expect(second).toBe("approve")

    const third = await runtime.decideSessionOpen({
      caller: { agentID: "agent_a", ownerUserID: 1 },
      label: "needs another approval",
    })
    expect(third).toBe("pending")
  })

  test("trusted identities and trusted-only mode auto-approve matching callers", async () => {
    await SynergyLinkCLIBackend.setApproval("trusted-only")
    await SynergyLinkCLIBackend.addTrust("agent", "agent_trusted")
    await SynergyLinkCLIBackend.addTrust("user", "42")

    const runtime = await SynergyLinkRuntime.create()

    await expect(runtime.decideSessionOpen({ caller: { agentID: "agent_trusted", ownerUserID: 7 } })).resolves.toBe(
      "approve",
    )

    await expect(runtime.decideSessionOpen({ caller: { agentID: "agent_other", ownerUserID: 42 } })).resolves.toBe(
      "approve",
    )

    await expect(runtime.decideSessionOpen({ caller: { agentID: "agent_other", ownerUserID: 99 } })).resolves.toBe(
      "pending",
    )
  })

  test("session responses report the observed host identity and capabilities", async () => {
    await SynergyLinkCLIBackend.setApproval("trusted-only")
    await SynergyLinkCLIBackend.addTrust("agent", "agent_observer")
    const runtime = await SynergyLinkRuntime.create()
    const linkID = runtime.state?.linkID
    expect(linkID).toBeTruthy()

    const response = await runtime.inbound.handle({
      caller: { type: "holos", agentID: "agent_observer", ownerUserID: 7 },
      body: {
        version: 2,
        requestID: "req_observe_host",
        linkID,
        tool: "session",
        action: "open",
        payload: { action: "open", label: "observe host" },
      },
    })

    expect(response.ok).toBe(true)
    if (!response.ok || response.tool !== "session") return
    expect(response.result.metadata.host).toEqual(
      expect.objectContaining({
        type: "synergy_link.host.hello",
        linkID,
        capabilities: expect.objectContaining({ platform: expect.any(String), arch: expect.any(String) }),
      }),
    )
  })

  test("revoking trusted-only access ends the current session immediately", async () => {
    await SynergyLinkCLIBackend.setApproval("trusted-only")
    await SynergyLinkCLIBackend.addTrust("agent", "agent_revoked")
    const runtime = await SynergyLinkRuntime.create()
    const linkID = runtime.state?.linkID
    expect(linkID).toBeTruthy()

    const opened = await runtime.inbound.handle({
      caller: { type: "holos", agentID: "agent_revoked", ownerUserID: 7 },
      body: {
        version: 2,
        requestID: "req_open_before_revoke",
        linkID,
        tool: "session",
        action: "open",
        payload: { action: "open" },
      },
    })
    expect(opened.ok).toBe(true)
    expect(runtime.sessions.current()?.remoteAgentID).toBe("agent_revoked")

    await runtime.removeTrust("agent", "agent_revoked")

    expect(runtime.sessions.current()).toBeNull()
    const reopened = await runtime.inbound.handle({
      caller: { type: "holos", agentID: "agent_revoked", ownerUserID: 7 },
      body: {
        version: 2,
        requestID: "req_open_after_revoke",
        linkID,
        tool: "session",
        action: "open",
        payload: { action: "open" },
      },
    })
    expect(reopened.ok).toBe(true)
    if (reopened.ok && reopened.tool === "session") expect(reopened.result.metadata.status).toBe("refused")
  })

  test("switching to trusted-only ends an untrusted current session immediately", async () => {
    await SynergyLinkCLIBackend.setApproval("auto")
    const runtime = await SynergyLinkRuntime.create()
    const linkID = runtime.state?.linkID
    expect(linkID).toBeTruthy()

    const opened = await runtime.inbound.handle({
      caller: { type: "holos", agentID: "agent_untrusted", ownerUserID: 9 },
      body: {
        version: 2,
        requestID: "req_open_before_policy_change",
        linkID,
        tool: "session",
        action: "open",
        payload: { action: "open" },
      },
    })
    expect(opened.ok).toBe(true)
    expect(runtime.sessions.current()?.remoteAgentID).toBe("agent_untrusted")

    await runtime.setApproval("trusted-only")

    expect(runtime.sessions.current()).toBeNull()
  })

  test("serializes policy tightening with an in-progress session open", async () => {
    await SynergyLinkCLIBackend.setApproval("auto")
    const runtime = await SynergyLinkRuntime.create()
    const linkID = runtime.state?.linkID
    expect(linkID).toBeTruthy()

    const openStarted = Promise.withResolvers<void>()
    const continueOpen = Promise.withResolvers<void>()
    const originalOpen = runtime.sessions.open.bind(runtime.sessions)
    runtime.sessions.open = async (...args) => {
      openStarted.resolve()
      await continueOpen.promise
      return await originalOpen(...args)
    }

    const openRequest = runtime.inbound.handle({
      caller: { type: "holos", agentID: "agent_opening", ownerUserID: 10 },
      body: {
        version: 2,
        requestID: "req_open_during_policy_change",
        linkID,
        tool: "session",
        action: "open",
        payload: { action: "open" },
      },
    })
    await openStarted.promise

    let policyCompleted = false
    const policyChange = runtime.setApproval("trusted-only").then(() => {
      policyCompleted = true
    })
    await Promise.resolve()
    expect(policyCompleted).toBe(false)

    continueOpen.resolve()
    const opened = await openRequest
    expect(opened.ok).toBe(true)
    await policyChange

    expect(runtime.sessions.current()).toBeNull()
    expect(runtime.state?.approvalMode).toBe("trusted-only")
  })
})
