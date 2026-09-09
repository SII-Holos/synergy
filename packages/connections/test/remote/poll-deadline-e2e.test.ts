import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SynergyLinkBridge, SynergyLinkEnvelope } from "@ericsanchezok/synergy-link-protocol"
import { RPCHandler, SessionManager, SynergyLinkInboundHandler, SynergyLinkLog } from "@ericsanchezok/synergy-link"
import { HolosRuntime } from "../../src/holos/runtime"
import { HolosSynergyLinkTransport } from "../../src/holos/synergy-link-transport"
import { HolosSynergyLinkClient } from "../../src/remote/client"

/**
 * Transport-level regression for the blocking-poll deadline race: the remote
 * host's blocking wait must conclude inside the sender's transport deadline
 * so a still-running result is delivered instead of a transport timeout.
 * Timers are scaled (1.5s host cap, 3s transport deadline, ~300ms simulated
 * request/response latency) so the ordering is exercised in milliseconds.
 */
describe("Synergy Link blocking-poll deadline ordering", () => {
  const LINK_ID = "link_poll_deadline"
  const TARGET_AGENT_ID = "agent_loopback_host"
  const HOST_CALLER = { type: "agent", agentID: "agent_loopback_caller", ownerUserID: 1 }
  const MAX_BLOCKING_POLL_MS = 1_500
  const TRANSPORT_TIMEOUT_MS = 3_000

  let home: string
  let originalLinkHome: string | undefined
  let rpc: RPCHandler
  let sessions: SessionManager
  let inbound: SynergyLinkInboundHandler

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "synergy-link-poll-deadline-"))
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    process.env.SYNERGY_LINK_HOME = home
    rpc = new RPCHandler({ linkID: LINK_ID, registry: { maxBlockingPollMs: MAX_BLOCKING_POLL_MS } })
    sessions = new SessionManager()
    inbound = new SynergyLinkInboundHandler(rpc, sessions, async () => "approve")
  })

  afterEach(async () => {
    await SynergyLinkLog.flush()
    if (originalLinkHome === undefined) delete process.env.SYNERGY_LINK_HOME
    else process.env.SYNERGY_LINK_HOME = originalLinkHome
    await rm(home, { recursive: true, force: true })
  })

  function clientFor() {
    const provider = {
      async send(_agent: string, _event: string, body: unknown) {
        // Simulated request and response latency: the remote handling does not
        // start or finish at zero cost relative to the transport deadline.
        await Bun.sleep(150)
        const result = await inbound.handle({ caller: HOST_CALLER, body })
        await Bun.sleep(150)
        await HolosRuntime.dispatchAppEvent({
          event: SynergyLinkBridge.RESPONSE_EVENT,
          payload: result,
          caller: { type: "agent", agent_id: TARGET_AGENT_ID, owner_user_id: 1 },
          source: provider,
        })
        return { sent: true }
      },
    }
    const transport = new HolosSynergyLinkTransport(provider, { timeoutMs: TRANSPORT_TIMEOUT_MS })
    return { client: new HolosSynergyLinkClient(transport), transport }
  }

  test("returns a still-running result before the transport deadline when the process outlives the wait", async () => {
    const { client, transport } = clientFor()
    try {
      const opened = await client.executeSession(LINK_ID, { action: "open" }, { targetAgentID: TARGET_AGENT_ID })
      expect(opened.metadata.status).toBe("opened")
      const sessionID = opened.metadata.sessionID
      expect(sessionID).toBeDefined()

      const started = await client.executeBash(
        LINK_ID,
        { command: "sleep 30", description: "deadline poll regression", background: true },
        { sessionID: sessionID!, targetAgentID: TARGET_AGENT_ID },
      )
      const processId = started.metadata.processId
      expect(processId).toBeDefined()

      const startedAt = Date.now()
      const polled = await client.executeProcess(
        LINK_ID,
        { action: "poll", processId: processId!, block: true, timeout: 30 },
        { sessionID: sessionID!, targetAgentID: TARGET_AGENT_ID },
      )
      const elapsed = Date.now() - startedAt

      expect(polled.metadata.status).toBe("running")
      expect(polled.output).toContain("Process still running.")
      expect(elapsed).toBeGreaterThanOrEqual(MAX_BLOCKING_POLL_MS - 400)
      expect(elapsed).toBeLessThan(TRANSPORT_TIMEOUT_MS - 400)
    } finally {
      await rpc.processRegistry.reset()
      transport.dispose()
    }
  }, 10_000)

  test("returns the terminal state when the process exits during the capped wait", async () => {
    const { client, transport } = clientFor()
    try {
      const opened = await client.executeSession(LINK_ID, { action: "open" }, { targetAgentID: TARGET_AGENT_ID })
      const sessionID = opened.metadata.sessionID
      expect(sessionID).toBeDefined()

      const started = await client.executeBash(
        LINK_ID,
        { command: "sleep 1", description: "deadline poll exit", background: true },
        { sessionID: sessionID!, targetAgentID: TARGET_AGENT_ID },
      )
      const processId = started.metadata.processId
      expect(processId).toBeDefined()

      const startedAt = Date.now()
      const polled = await client.executeProcess(
        LINK_ID,
        { action: "poll", processId: processId!, block: true, timeout: 30 },
        { sessionID: sessionID!, targetAgentID: TARGET_AGENT_ID },
      )
      const elapsed = Date.now() - startedAt

      expect(polled.metadata.status).toBe("completed")
      expect(polled.output).toContain("Process exited with")
      expect(elapsed).toBeLessThan(TRANSPORT_TIMEOUT_MS - 400)
    } finally {
      await rpc.processRegistry.reset()
      transport.dispose()
    }
  }, 10_000)
})
