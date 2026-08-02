import { describe, expect, test } from "bun:test"
import { SessionManager } from "../src/session/manager.js"

describe("synergy-link session manager", () => {
  test("opens a session for the first caller", async () => {
    const manager = new SessionManager()
    const result = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    expect(result.metadata.status).toBe("opened")
    expect(result.metadata.sessionID).toBeTruthy()
  })

  test("waits for state persistence before reporting an opened session", async () => {
    let release!: () => void
    const persisted = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = new SessionManager({ onChange: () => persisted })
    let settled = false

    const opening = manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 }).then((result) => {
      settled = true
      return result
    })
    await Bun.sleep(0)

    expect(settled).toBe(false)
    release()
    await expect(opening).resolves.toMatchObject({ metadata: { status: "opened" } })
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
    const kicked = await manager.kickCurrent()
    expect(kicked?.remoteAgentID).toBe("agent_a")
    const retry = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    expect(retry.metadata.status).toBe("opened")
  })

  test("refuses an opening session when the caller is blocked during persistence", async () => {
    const openPersistStarted = Promise.withResolvers<void>()
    const continueOpenPersist = Promise.withResolvers<void>()
    let changeCount = 0
    const manager = new SessionManager({
      onChange: async ({ current }) => {
        changeCount += 1
        if (changeCount !== 1 || !current) return
        openPersistStarted.resolve()
        await continueOpenPersist.promise
      },
    })

    const opening = manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    await openPersistStarted.promise
    await manager.setBlockedAgentIDs(["agent_a"])
    continueOpenPersist.resolve()

    await expect(opening).resolves.toMatchObject({ metadata: { status: "refused" } })
    expect(manager.current()).toBeNull()
    expect(manager.isBlocked("agent_a")).toBe(true)
  })

  test("idle sessions expire after timeout", async () => {
    const manager = new SessionManager({ timeoutMs: 60_000 })
    const opened = await manager.open({ type: "agent", agentID: "agent_a", ownerUserID: 1 })
    const sessionID = opened.metadata.sessionID
    expect(sessionID).toBeTruthy()
    const expired = await manager.expireIdle(Date.now() + 61_000)
    expect(expired?.sessionID).toBe(sessionID)
    expect(manager.current()).toBeNull()
  })
})
