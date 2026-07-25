import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SynergyLinkInboundHandler, SessionManager, RPCHandler } from "@ericsanchezok/synergy-link"
import type { SynergyLinkRequest } from "../../src/remote/client"
import { HolosSynergyLinkClient } from "../../src/remote/client"

describe("Synergy Link loopback E2E", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "synergy-link-loopback-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function host() {
    const sessions = new SessionManager()
    const rpc = new RPCHandler({ linkID: "link_loopback" })
    const inbound = new SynergyLinkInboundHandler(rpc, sessions, async () => "approve")
    return { inbound, sessions }
  }

  function clientFor(inbound: SynergyLinkInboundHandler) {
    const caller = {
      type: "agent" as const,
      agentID: "agent_loopback_caller",
      ownerUserID: 1,
    }
    const transport = {
      async request(targetAgentID: string | undefined, input: SynergyLinkRequest) {
        expect(targetAgentID).toBe("agent_loopback_host")
        expect(input).not.toHaveProperty("targetAgentID")
        const response = await inbound.handle({ caller, body: input })
        expect(response).not.toBeNull()
        return response
      },
    }
    return new HolosSynergyLinkClient(transport)
  }

  test("open → bash → process list → heartbeat → close over the strict protocol", async () => {
    const { inbound, sessions } = host()
    const client = clientFor(inbound)

    const opened = await client.executeSession(
      "link_loopback",
      { action: "open", label: "loopback" },
      { targetAgentID: "agent_loopback_host" },
    )
    expect(opened.metadata.status).toBe("opened")
    const sessionID = opened.metadata.sessionID
    expect(sessionID).toBeDefined()
    expect(sessions.current()?.sessionID).toBe(sessionID)

    const bash = await client.executeBash(
      "link_loopback",
      { command: "echo ok", description: "loopback echo", workdir: home },
      { sessionID: sessionID!, targetAgentID: "agent_loopback_host" },
    )
    expect(bash.metadata.exit).toBe(0)
    expect(bash.output).toContain("ok")

    const processes = await client.executeProcess(
      "link_loopback",
      { action: "list" },
      { sessionID: sessionID!, targetAgentID: "agent_loopback_host" },
    )
    expect(Array.isArray(processes.metadata.processes)).toBe(true)

    const heartbeat = await client.executeSession(
      "link_loopback",
      { action: "heartbeat", sessionID: sessionID! },
      { targetAgentID: "agent_loopback_host" },
    )
    expect(heartbeat.metadata.action).toBe("heartbeat")

    const closed = await client.executeSession(
      "link_loopback",
      { action: "close", sessionID: sessionID! },
      { targetAgentID: "agent_loopback_host" },
    )
    expect(closed.metadata.status).toBe("closed")
    expect(sessions.current()).toBeNull()
  })

  test("host-side strict schema rejects requests with extra envelope keys", async () => {
    const { inbound } = host()

    const response = await inbound.handle({
      caller: { type: "agent", agentID: "agent_loopback_caller", ownerUserID: 1 },
      body: {
        version: 2,
        requestID: crypto.randomUUID(),
        linkID: "link_loopback",
        tool: "session",
        action: "open",
        targetAgentID: "agent_loopback_host",
        payload: { action: "open" },
      },
    })

    expect(response).toMatchObject({ ok: false })
  })
})
