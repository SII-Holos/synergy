import { describe, expect, test } from "bun:test"
import { SessionManager } from "../src/session/manager.js"

describe("synergy-link session manager", () => {
  test("opens a session for the first caller", async () => {
    const manager = new SessionManager()
    const result = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    expect(result.metadata.status).toBe("opened")
    expect(result.metadata.sessionID).toBeTruthy()
  })

  test("reuses the active session when the same Holos caller reconnects", async () => {
    const manager = new SessionManager()
    const caller = { type: "agent" as const, agentID: "agent_a", ownerUserID: 1 }
    const opened = await manager.open(caller, "build")
    const reopened = await manager.open(caller, "build again")

    expect(reopened.metadata.status).toBe("opened")
    expect(reopened.metadata.sessionID).toBe(opened.metadata.sessionID)
    expect(manager.current()?.label).toBe("build")
  })

  test("keeps the host busy when the agent matches but the owner differs", async () => {
    const manager = new SessionManager()
    await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    const result = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 2 })

    expect(result.metadata.status).toBe("busy")
  })

  test("rejects a different caller while busy", async () => {
    const manager = new SessionManager()
    await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    const result = await manager.open({ type: "agent", agentID: "agent_b", ownerUserID: 2 })
    expect(result.metadata.status).toBe("busy")
  })

  test("kicking a session disconnects without blocking by default", async () => {
    const manager = new SessionManager()
    await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    const kicked = manager.kickCurrent()
    expect(kicked?.remoteAgentID).toBe("agent_a")
    const retry = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    expect(retry.metadata.status).toBe("opened")
  })

  test("idle sessions expire after timeout", async () => {
    const manager = new SessionManager({ timeoutMs: 60_000 })
    const opened = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    const sessionID = opened.metadata.sessionID
    expect(sessionID).toBeTruthy()
    const expired = manager.expireIdle(Date.now() + 61_000)
    expect(expired?.sessionID).toBe(sessionID)
    expect(manager.current()).toBeNull()
  })
})
