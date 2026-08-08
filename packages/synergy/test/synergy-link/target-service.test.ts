import { afterEach, describe, expect, test } from "bun:test"
import type {
  SynergyLinkBash,
  SynergyLinkClient,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkRemoteError } from "../../src/remote/client"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { SynergyLinkTargetService } from "../../src/synergy-link/target-service"
import { SynergyLinkTargetStore } from "../../src/synergy-link/target-store"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

function client(
  executeSession: SynergyLinkClient.ExecutionClient["executeSession"],
): SynergyLinkClient.ExecutionClient {
  return {
    executeBash: async (): Promise<SynergyLinkBash.Result> => {
      throw new Error("unexpected bash execution")
    },
    executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
      throw new Error("unexpected process execution")
    },
    executeSession,
  }
}

afterEach(async () => {
  SynergyLinkExecution.setClient(null)
  await Storage.removeTree(StoragePath.synergyLinkTargetsRoot())
})

describe("Synergy Link target service", () => {
  test("closes an active remote session before removing its target", async () => {
    const calls: Array<{ linkID: string; payload: SynergyLinkSession.ExecutePayload; targetAgentID?: string }> = []
    SynergyLinkExecution.setClient(
      client(async (linkID, payload, options): Promise<SynergyLinkSession.Result> => {
        calls.push({ linkID, payload, targetAgentID: options?.targetAgentID })
        return {
          title: "Session closed",
          metadata: { action: "close", status: "closed", sessionID: "session_remove", backend: "remote" },
          output: "Closed.",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Removed host",
      targetAgentID: "agent_remove",
      linkID: "link_remove",
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_remove",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    await SynergyLinkTargetService.remove(target.id)

    expect(calls).toEqual([
      {
        linkID: target.linkID,
        payload: { action: "close", sessionID: "session_remove" },
        targetAgentID: target.targetAgentID,
      },
    ])
    expect(await SynergyLinkTargetStore.get(target.id)).toBeUndefined()
    expect(SynergyLinkExecution.getSession(target.linkID)).toBeUndefined()
  })

  test("still removes the target when its remote session cannot close", async () => {
    SynergyLinkExecution.setClient(
      client(async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("transport offline")
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Offline host",
      targetAgentID: "agent_offline",
      linkID: "link_offline",
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_offline",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    await SynergyLinkTargetService.remove(target.id)

    expect(await SynergyLinkTargetStore.get(target.id)).toBeUndefined()
    expect(SynergyLinkExecution.getSession(target.linkID)).toBeUndefined()
  })

  test("ignores a host observation from a replaced locator", async () => {
    const target = await SynergyLinkTargetStore.create({
      name: "Replaced probe host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })
    const relinked = await SynergyLinkTargetStore.update(
      target.id,
      { kind: "relink", targetAgentID: "agent_new", linkID: "link_new" },
      {},
    )

    const observed = await SynergyLinkTargetService.recordProbe(
      target.id,
      {
        status: "reachable",
        host: {
          type: "synergy_link.host.hello",
          linkID: "link_old",
          hostSessionID: "host_old",
          capabilities: {
            platform: "linux",
            arch: "x64",
            runtime: "bun",
            defaultShell: "sh",
            supportedShells: ["sh"],
            supportsPty: false,
            supportsSendKeys: true,
            supportsSoftKill: true,
            supportsProcessGroups: true,
            envCaseInsensitive: false,
            lineEndings: "lf",
          },
          observedAt: Date.now(),
        },
      },
      { linkID: target.linkID, targetAgentID: target.targetAgentID },
    )

    expect(observed).toEqual(relinked)
    expect(await SynergyLinkTargetStore.require(target.id)).toEqual(relinked)
  })
})

describe("Synergy Link target service relink", () => {
  test("probe-verifies the new locator, applies the complete patch, and closes the old session", async () => {
    const calls: Array<{ linkID: string; payload: SynergyLinkSession.ExecutePayload; targetAgentID?: string }> = []
    SynergyLinkExecution.setClient(
      client(async (linkID, payload, options): Promise<SynergyLinkSession.Result> => {
        calls.push({ linkID, payload, targetAgentID: options?.targetAgentID })
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: payload.action === "open" ? "session_new" : payload.sessionID,
            backend: "remote",
            host:
              payload.action === "open"
                ? {
                    type: "synergy_link.host.hello",
                    linkID: "link_new",
                    hostSessionID: "host_new",
                    capabilities: {
                      platform: "linux",
                      arch: "x64",
                      runtime: "bun",
                      defaultShell: "sh",
                      supportedShells: ["sh"],
                      supportsPty: false,
                      supportsSendKeys: true,
                      supportsSoftKill: true,
                      supportsProcessGroups: true,
                      envCaseInsensitive: false,
                      lineEndings: "lf",
                    },
                  }
                : undefined,
          },
          output: "ok",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Relink service host",
      targetAgentID: "agent_old",
      linkID: "link_old",
      allowedAgents: ["build"],
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_old",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    const updated = await SynergyLinkTargetService.update(target.id, {
      kind: "relink",
      name: "Relinked service host",
      enabled: false,
      allowedAgents: ["ops"],
      targetAgentID: "agent_new",
      linkID: "link_new",
    })

    expect(calls).toEqual([
      {
        linkID: "link_new",
        payload: { action: "open", label: "Relink verification: Relink service host" },
        targetAgentID: "agent_new",
      },
      {
        linkID: "link_old",
        payload: { action: "close", sessionID: "session_old" },
        targetAgentID: "agent_old",
      },
      {
        linkID: "link_new",
        payload: { action: "close", sessionID: "session_new" },
        targetAgentID: "agent_new",
      },
    ])
    expect(updated.targetAgentID).toBe("agent_new")
    expect(updated.linkID).toBe("link_new")
    expect(updated.name).toBe("Relinked service host")
    expect(updated.enabled).toBe(false)
    expect(updated.allowedAgents).toEqual(["ops"])
    expect(updated.authorization).toBe("approved")
    expect(updated.lastProbe?.status).toBe("reachable")
    expect(SynergyLinkExecution.getSession("link_old")).toBeUndefined()
  })

  test("does not close a remotely reused relink session when the local cache is empty", async () => {
    const calls: SynergyLinkSession.ExecutePayload[] = []
    SynergyLinkExecution.setClient(
      client(async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        calls.push(payload)
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: "session_reused",
            reused: payload.action === "open" ? true : undefined,
            backend: "remote",
          },
          output: "ok",
        } as SynergyLinkSession.Result
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Cache-cleared reuse host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })
    await SynergyLinkTargetStore.recordProbe(target.id, {
      status: "reachable",
      host: {
        type: "synergy_link.host.hello",
        linkID: "link_old",
        hostSessionID: "host_old",
        capabilities: {
          platform: "linux",
          arch: "x64",
          runtime: "bun",
          defaultShell: "sh",
          supportedShells: ["sh"],
          supportsPty: false,
          supportsSendKeys: true,
          supportsSoftKill: true,
          supportsProcessGroups: true,
          envCaseInsensitive: false,
          lineEndings: "lf",
        },
        observedAt: 1,
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_new",
      targetAgentID: "agent_new",
      sourceAgent: "build",
      sessionID: "session_reused",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    SynergyLinkExecution.clearSession("link_new", { targetAgentID: "agent_new" })

    const updated = await SynergyLinkTargetService.update(target.id, {
      kind: "relink",
      targetAgentID: "agent_new",
      linkID: "link_new",
    })

    expect(calls).toEqual([{ action: "open", label: "Relink verification: Cache-cleared reuse host" }])
    expect(updated.linkID).toBe("link_new")
    expect(updated.authorization).toBe("approved")
    expect(updated.lastProbe?.status).toBe("reachable")
    expect(updated.host).toBeUndefined()
  })

  test("heartbeats but does not close a reused session for the new locator", async () => {
    const calls: Array<{ linkID: string; payload: SynergyLinkSession.ExecutePayload }> = []
    SynergyLinkExecution.setClient(
      client(async (linkID, payload): Promise<SynergyLinkSession.Result> => {
        calls.push({ linkID, payload })
        return {
          title: payload.action === "heartbeat" ? "Alive" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "heartbeat" ? "alive" : "closed",
            sessionID: payload.action === "open" ? undefined : payload.sessionID,
            backend: "remote",
            host:
              payload.action === "heartbeat"
                ? {
                    type: "synergy_link.host.hello",
                    linkID: "link_new",
                    hostSessionID: "host_new",
                    capabilities: {
                      platform: "linux",
                      arch: "x64",
                      runtime: "bun",
                      defaultShell: "sh",
                      supportedShells: ["sh"],
                      supportsPty: false,
                      supportsSendKeys: true,
                      supportsSoftKill: true,
                      supportsProcessGroups: true,
                      envCaseInsensitive: false,
                      lineEndings: "lf",
                    },
                  }
                : undefined,
          },
          output: "ok",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Reuse session host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_new",
      targetID: "target_stale",
      targetAgentID: "agent_new",
      sourceAgent: "build",
      sessionID: "session_reused",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      supportsBashDetach: true,
    })

    await SynergyLinkTargetService.update(target.id, {
      kind: "relink",
      targetAgentID: "agent_new",
      linkID: "link_new",
    })

    expect(calls).toEqual([
      {
        linkID: "link_new",
        payload: { action: "heartbeat", sessionID: "session_reused" },
      },
    ])
    expect(
      SynergyLinkExecution.getSession("link_new", { targetID: target.id, targetAgentID: "agent_new" }),
    ).toMatchObject({
      sessionID: "session_reused",
      targetID: target.id,
      lastVerifiedAt: expect.any(Number),
      supportsBashDetach: false,
    })
  })
  test("clears an invalid reused session and opens a fresh relink verification session", async () => {
    const calls: SynergyLinkSession.ExecutePayload[] = []
    SynergyLinkExecution.setClient(
      client(async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        calls.push(payload)
        if (payload.action === "heartbeat") {
          throw new SynergyLinkRemoteError("session_invalid", "Session is not active.")
        }
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: payload.action === "open" ? "session_fresh" : payload.sessionID,
            backend: "remote",
            host:
              payload.action === "open"
                ? {
                    type: "synergy_link.host.hello",
                    linkID: "link_new",
                    hostSessionID: "host_new",
                    capabilities: {
                      platform: "linux",
                      arch: "x64",
                      runtime: "bun",
                      defaultShell: "sh",
                      supportedShells: ["sh"],
                      supportsPty: false,
                      supportsSendKeys: true,
                      supportsSoftKill: true,
                      supportsProcessGroups: true,
                      envCaseInsensitive: false,
                      lineEndings: "lf",
                    },
                  }
                : undefined,
          },
          output: "ok",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Stale session host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_new",
      targetAgentID: "agent_new",
      sourceAgent: "build",
      sessionID: "session_stale",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    const updated = await SynergyLinkTargetService.update(target.id, {
      kind: "relink",
      targetAgentID: "agent_new",
      linkID: "link_new",
    })

    expect(calls).toEqual([
      { action: "heartbeat", sessionID: "session_stale" },
      { action: "open", label: "Relink verification: Stale session host" },
      { action: "close", sessionID: "session_fresh" },
    ])
    expect(updated.linkID).toBe("link_new")
    expect(updated.lastProbe?.status).toBe("reachable")
    expect(SynergyLinkExecution.getSession("link_new", { targetAgentID: "agent_new" })).toBeUndefined()
  })
  test("reopens relink verification when a reused session heartbeat reports closed", async () => {
    const calls: SynergyLinkSession.ExecutePayload[] = []
    SynergyLinkExecution.setClient(
      client(async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        calls.push(payload)
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: payload.action === "open" ? "session_fresh" : payload.sessionID,
            backend: "remote",
            host:
              payload.action === "open"
                ? {
                    type: "synergy_link.host.hello",
                    linkID: "link_new",
                    hostSessionID: "host_new",
                    capabilities: {
                      platform: "linux",
                      arch: "x64",
                      runtime: "bun",
                      defaultShell: "sh",
                      supportedShells: ["sh"],
                      supportsPty: false,
                      supportsSendKeys: true,
                      supportsSoftKill: true,
                      supportsProcessGroups: true,
                      envCaseInsensitive: false,
                      lineEndings: "lf",
                    },
                  }
                : undefined,
          },
          output: "ok",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Closed session host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_new",
      targetAgentID: "agent_new",
      sourceAgent: "build",
      sessionID: "session_closed",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    const updated = await SynergyLinkTargetService.update(target.id, {
      kind: "relink",
      targetAgentID: "agent_new",
      linkID: "link_new",
    })

    expect(calls).toEqual([
      { action: "heartbeat", sessionID: "session_closed" },
      { action: "open", label: "Relink verification: Closed session host" },
      { action: "close", sessionID: "session_fresh" },
    ])
    expect(updated.linkID).toBe("link_new")
    expect(updated.lastProbe?.status).toBe("reachable")
    expect(SynergyLinkExecution.getSession("link_new", { targetAgentID: "agent_new" })).toBeUndefined()
  })

  test("rejects a locator collision before probing or closing a reused session", async () => {
    const calls: SynergyLinkSession.ExecutePayload[] = []
    SynergyLinkExecution.setClient(
      client(async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        calls.push(payload)
        throw new Error("unexpected session request")
      }),
    )
    const existing = await SynergyLinkTargetStore.create({
      name: "Existing locator",
      targetAgentID: "agent_existing",
      linkID: "link_existing",
    })
    const relinked = await SynergyLinkTargetStore.create({
      name: "Relink candidate",
      targetAgentID: "agent_candidate",
      linkID: "link_candidate",
    })
    SynergyLinkExecution.upsertSession({
      linkID: existing.linkID,
      targetID: existing.id,
      targetAgentID: existing.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_existing",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    await expect(
      SynergyLinkTargetService.update(relinked.id, {
        kind: "relink",
        targetAgentID: existing.targetAgentID,
        linkID: existing.linkID,
      }),
    ).rejects.toThrow("already in use")

    expect(calls).toEqual([])
    expect(SynergyLinkExecution.getSession(existing.linkID, { targetAgentID: existing.targetAgentID })?.sessionID).toBe(
      "session_existing",
    )
    expect(await SynergyLinkTargetStore.require(relinked.id)).toEqual(relinked)
  })

  test("serializes removal with the complete relink transaction", async () => {
    const probeStarted = Promise.withResolvers<void>()
    const continueProbe = Promise.withResolvers<void>()
    SynergyLinkExecution.setClient(
      client(async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        if (payload.action === "open") {
          probeStarted.resolve()
          await continueProbe.promise
        }
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: payload.action === "open" ? "session_new" : payload.sessionID,
            backend: "remote",
          },
          output: "ok",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Concurrent relink host",
      targetAgentID: "agent_old",
      linkID: "link_old",
    })

    const relink = SynergyLinkTargetService.update(target.id, {
      kind: "relink",
      targetAgentID: "agent_new",
      linkID: "link_new",
    })
    try {
      await probeStarted.promise
      let removalSettled = false
      const removal = SynergyLinkTargetService.remove(target.id).then(() => {
        removalSettled = true
      })
      await Bun.sleep(0)

      expect(removalSettled).toBe(false)
      continueProbe.resolve()
      await expect(relink).resolves.toMatchObject({ linkID: "link_new" })
      await removal
      expect(await SynergyLinkTargetStore.get(target.id)).toBeUndefined()
    } finally {
      continueProbe.resolve()
      await relink.catch(() => undefined)
    }
  })

  test("rolls back and preserves the original target when the new locator probe fails", async () => {
    SynergyLinkExecution.setClient(
      client(async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("connection refused")
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Relink failure host",
      targetAgentID: "agent_old",
      linkID: "link_old",
      allowedAgents: ["build"],
    })

    await expect(
      SynergyLinkTargetService.update(target.id, {
        kind: "relink",
        targetAgentID: "agent_new",
        linkID: "link_new",
      }),
    ).rejects.toThrow("connection refused")

    const unchanged = await SynergyLinkTargetStore.require(target.id)
    expect(unchanged.targetAgentID).toBe("agent_old")
    expect(unchanged.linkID).toBe("link_old")
    expect(unchanged.name).toBe("Relink failure host")
    expect(unchanged.allowedAgents).toEqual(["build"])
    expect(unchanged.authorization).toBe("unverified")
  })
})
