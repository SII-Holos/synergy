import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { BossRuntime } from "../../src/boss/boss-runtime"
import { Provider } from "../../src/provider/provider"
import { SessionManager } from "../../src/session/manager"
import { Config } from "../../src/config/config"

const originalConfigCurrent = Config.current

const originalProviderDefaultModel = Provider.defaultModel
const originalScheduleWake = SessionManager.scheduleWake
const originalLatestRootID = SessionInbox.latestRootID

afterEach(() => {
  Config.current = originalConfigCurrent
  Provider.defaultModel = originalProviderDefaultModel
  SessionManager.scheduleWake = originalScheduleWake
  SessionInbox.latestRootID = originalLatestRootID
  BossRuntime.sync(false).catch(() => {})
})

beforeEach(async () => {
  // Remove any boss sessions left in home scope by a previous test so each
  // test starts from a clean slate (shared home-scope storage).
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const sessions: Session.Info[] = []
      for await (const s of Session.listAll()) sessions.push(s)
      for (const s of sessions) {
        if (s.workflow?.kind === "boss" && s.workflow.role === "boss") {
          await Session.remove(s.id).catch(() => {})
        }
      }
    },
  })
})

function stubConfig(partial: Record<string, unknown>): void {
  Config.current = mock(async () => Config.Info.parse(partial as unknown as Config.Info)) as typeof Config.current
}

const FEISHU_CFG: Record<string, unknown> = {
  channel: {
    feishu: {
      type: "feishu",
      streaming: false,
      responseFormat: "text",
      accounts: {
        acct1: { appId: "a", appSecret: "b", enabled: true },
        acct2: { appId: "c", appSecret: "d", enabled: true },
        disabled1: { appId: "e", appSecret: "f", enabled: false },
      },
    },
  },
  experimental: { boss_mode: true },
}

const FEISHU_ONE: Record<string, unknown> = {
  channel: {
    feishu: {
      type: "feishu",
      streaming: false,
      responseFormat: "text",
      accounts: { acct1: { appId: "a", appSecret: "b" } },
    },
  },
  experimental: { boss_mode: true },
}

async function withHomeScope<T>(fn: () => Promise<T>): Promise<T> {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

describe("BossRuntime", () => {
  test("ensure() does nothing when boss_mode is disabled", async () => {
    await withHomeScope(async () => {
      stubConfig({})
      await BossRuntime.ensure()
      expect(BossRuntime.bossSessionForAccount("acct1")).toBeUndefined()
    })
  })

  test("ensure() provisions one boss session per enabled feishu account in home scope", async () => {
    await withHomeScope(async () => {
      stubConfig(FEISHU_CFG)
      await BossRuntime.ensure()

      expect(BossRuntime.bossSessionForAccount("acct1")).toBeDefined()
      expect(BossRuntime.bossSessionForAccount("acct2")).toBeDefined()
      expect(BossRuntime.bossSessionForAccount("disabled1")).toBeUndefined()

      const boss1 = await Session.get(BossRuntime.bossSessionForAccount("acct1")!)
      expect(boss1.workflow).toEqual({ kind: "boss", role: "boss" })
      expect(boss1.interaction).toMatchObject({ mode: "interactive" })
      expect(boss1.endpoint?.kind).toBe("channel")
      expect((boss1.scope as Scope).id).toBe("home")
      expect(SessionEndpoint.toKey(boss1.endpoint!)).toContain("scope:boss")
    })
  })

  test("ensure() is idempotent — repeated calls reuse the same session", async () => {
    await withHomeScope(async () => {
      stubConfig(FEISHU_ONE)
      await BossRuntime.ensure()
      const first = BossRuntime.bossSessionForAccount("acct1")
      await BossRuntime.ensure()
      expect(BossRuntime.bossSessionForAccount("acct1")).toBe(first)

      const sessions: Session.Info[] = []
      for await (const s of Session.listAll()) sessions.push(s)
      const bosses = sessions.filter(
        (s) => s.workflow?.kind === "boss" && s.workflow.role === "boss" && s.endpoint?.kind === "channel",
      )
      expect(bosses).toHaveLength(1)
    })
  })

  test("ensure() upgrades an existing pre-agent boss session to boss-synergy", async () => {
    await withHomeScope(async () => {
      stubConfig(FEISHU_ONE)
      // Simulate a session created by older code (agentOverride: "synergy").
      const legacy = await Session.create({
        scope: Scope.home(),
        endpoint: SessionEndpoint.fromChannel({
          type: "feishu",
          accountId: "acct1",
          chatId: BossRuntime.BOSS_CHAT_ID,
          chatType: "group",
          chatName: BossRuntime.BOSS_SESSION_TITLE,
          scopeKey: BossRuntime.BOSS_SCOPE_KEY,
          createdAt: Date.now(),
        }),
        interaction: { mode: "interactive", source: "boss" },
        title: BossRuntime.BOSS_SESSION_TITLE,
        agentOverride: "synergy",
        workflow: { kind: "boss", role: "boss" },
      })

      await BossRuntime.ensure()

      const boss = await Session.get(legacy.id)
      expect(boss.agentOverride).toBe("boss-synergy")
      // Same session reused (no duplicate provisioned).
      expect(BossRuntime.bossSessionForAccount("acct1")).toBe(legacy.id)
    })
  })

  test("sync(false) clears routing without deleting sessions", async () => {
    await withHomeScope(async () => {
      stubConfig(FEISHU_ONE)
      await BossRuntime.ensure()
      const sessionID = BossRuntime.bossSessionForAccount("acct1")!

      await BossRuntime.sync(false)
      expect(BossRuntime.bossSessionForAccount("acct1")).toBeUndefined()
      expect(await Session.get(sessionID)).toBeDefined()
    })
  })

  test("refreshIdentity delivers a versioned briefing with a new deliveryKey", async () => {
    await withHomeScope(async () => {
      stubConfig({ ...FEISHU_ONE, experimental: { boss_mode: true, boss_identity_text: "我是同事小飞" } })
      await BossRuntime.ensure()
      const sessionID = BossRuntime.bossSessionForAccount("acct1")!

      // Activation briefing (fixed key) is in the inbox.
      const before = await SessionInbox.list(sessionID)
      expect(before.some((item) => item.message?.origin?.detail === "boss_identity")).toBe(true)

      // Refresh with versioned key adds a new item; the fixed-key item is not duplicated.
      await BossRuntime.refreshIdentity({ versioned: true })
      const after = await SessionInbox.list(sessionID)
      const identityItems = after.filter((item) => item.message?.origin?.detail === "boss_identity")
      expect(identityItems.length).toBeGreaterThanOrEqual(1)
      const fixedKeyItems = after.filter(
        (item) => item.deliveryKey === `boss-identity:${sessionID}` && item.message?.origin?.detail === "boss_identity",
      )
      expect(fixedKeyItems.length).toBeLessThanOrEqual(1)
    })
  })

  test("buildBossIdentityBriefing enumerates identity + projects + sessions sections", async () => {
    await withHomeScope(async () => {
      stubConfig({})
      const briefing = await BossRuntime.buildBossIdentityBriefing("测试身份")
      expect(briefing).toContain("测试身份")
      expect(briefing).toContain("## 项目")
      expect(briefing).toContain("## 会话")
      expect(briefing).toContain("## 议程")
      expect(briefing).toContain("## 身份记忆")
      expect(briefing).toContain("## 经验教训")
      expect(briefing).toContain("<boss-world-overview>")
    })
  })

  test("periodic briefing agenda item is created per account when boss_briefing_interval_days is set", async () => {
    await withHomeScope(async () => {
      stubConfig({ ...FEISHU_CFG, experimental: { boss_mode: true, boss_briefing_interval_days: 7 } })
      await BossRuntime.ensure()
      const { AgendaStore } = await import("../../src/agenda/store")
      const item = await AgendaStore.get("home", BossRuntime.briefingAgendaID("acct1")).catch(() => undefined)
      expect(item).toBeDefined()
      expect(item!.triggers).toContainEqual({ type: "every", interval: "7d" })
      expect(item!.origin.sessionID).toBe(BossRuntime.bossSessionForAccount("acct1"))
      // One item per enabled account — the second account gets its own item.
      const item2 = await AgendaStore.get("home", BossRuntime.briefingAgendaID("acct2")).catch(() => undefined)
      expect(item2).toBeDefined()
      expect(item2!.origin.sessionID).toBe(BossRuntime.bossSessionForAccount("acct2"))
    })
  })

  test("rescheduleBriefing updates each account's agenda item to the new interval", async () => {
    await withHomeScope(async () => {
      stubConfig({ ...FEISHU_ONE, experimental: { boss_mode: true, boss_briefing_interval_days: 7 } })
      await BossRuntime.ensure()
      const { AgendaStore } = await import("../../src/agenda/store")
      const itemID = BossRuntime.briefingAgendaID("acct1")
      const before = await AgendaStore.get("home", itemID).catch(() => undefined)
      expect(before).toBeDefined()
      expect(before!.triggers).toContainEqual({ type: "every", interval: "7d" })

      // Interval change re-registers the same per-account item with the new cadence.
      stubConfig({ ...FEISHU_ONE, experimental: { boss_mode: true, boss_briefing_interval_days: 3 } })
      await BossRuntime.rescheduleBriefing()
      const after = await AgendaStore.get("home", itemID).catch(() => undefined)
      expect(after).toBeDefined()
      expect(after!.triggers).toContainEqual({ type: "every", interval: "3d" })
      expect(after!.triggers).not.toContainEqual({ type: "every", interval: "7d" })
    })
  })

  test("openSession() throws BossSessionOpenError when boss_mode is disabled", async () => {
    await withHomeScope(async () => {
      stubConfig({})
      await expect(BossRuntime.openSession()).rejects.toThrow("Boss Mode is disabled")
    })
  })

  test("openSession() creates a channel-less local boss session when no routable account exists", async () => {
    await withHomeScope(async () => {
      stubConfig({ experimental: { boss_mode: true } })
      const sessionID = await BossRuntime.openSession()
      const session = await Session.get(sessionID)
      expect(session).toBeDefined()
      expect(session!.workflow).toEqual({ kind: "boss", role: "boss" })
      expect(session!.agentOverride).toBe("boss-synergy")
      expect(session!.endpoint?.kind).not.toBe("channel")
      expect((session!.scope as Scope).id).toBe("home")
      expect(session!.title).toBe(BossRuntime.LOCAL_BOSS_SESSION_TITLE)

      // Second open reuses the same local session (idempotent).
      expect(await BossRuntime.openSession()).toBe(sessionID)
    })
  })

  test("openSession() prefers the channel-routed boss session when one exists", async () => {
    await withHomeScope(async () => {
      stubConfig(FEISHU_ONE)
      await BossRuntime.ensure()
      const routed = BossRuntime.bossSessionForAccount("acct1")!
      expect(await BossRuntime.openSession()).toBe(routed)
    })
  })

  test("openSession() skips the greeting kickoff when no model is available", async () => {
    await withHomeScope(async () => {
      stubConfig({ experimental: { boss_mode: true } })
      Provider.defaultModel = mock(async () => {
        throw new Error("no model")
      }) as typeof Provider.defaultModel
      const wakes: Array<[string, string]> = []
      SessionManager.scheduleWake = mock((sessionID: string, reason: string) => {
        wakes.push([sessionID, reason])
      }) as typeof SessionManager.scheduleWake

      const sessionID = await BossRuntime.openSession()
      const items = await SessionInbox.list(sessionID)
      // Only the one-time identity briefing steer is present; no task kickoff.
      expect(items.filter((item) => item.mode === "task")).toHaveLength(0)
      expect(items.some((item) => item.message?.origin?.detail === "boss_identity")).toBe(true)
      expect(wakes).toEqual([])
    })
  })

  test("openSession() queues one greeting kickoff task and wakes the session when a model is available", async () => {
    await withHomeScope(async () => {
      stubConfig({ experimental: { boss_mode: true } })
      Provider.defaultModel = mock(async () => ({
        providerID: "test",
        modelID: "model",
      })) as typeof Provider.defaultModel
      const wakes: Array<[string, string]> = []
      SessionManager.scheduleWake = mock((sessionID: string, reason: string) => {
        wakes.push([sessionID, reason])
      }) as typeof SessionManager.scheduleWake

      const sessionID = await BossRuntime.openSession()
      const kickoffItems = (await SessionInbox.list(sessionID)).filter(
        (item) => item.mode === "task" && item.deliveryKey === `boss-open:${sessionID}`,
      )
      expect(kickoffItems).toHaveLength(1)
      expect(kickoffItems[0].message?.origin?.detail).toBe("boss_open")
      expect(kickoffItems[0].message?.parts?.[0]?.type).toBe("text")
      expect((kickoffItems[0].message?.parts?.[0] as { text: string }).text).toBe(BossRuntime.LOCAL_BOSS_KICKOFF_TEXT)
      expect(wakes).toEqual([[sessionID, "boss_open"]])

      // Second open reuses the same session and does not queue a duplicate.
      expect(await BossRuntime.openSession()).toBe(sessionID)
      const after = (await SessionInbox.list(sessionID)).filter(
        (item) => item.mode === "task" && item.deliveryKey === `boss-open:${sessionID}`,
      )
      expect(after).toHaveLength(1)
      expect(wakes).toEqual([[sessionID, "boss_open"]])
    })
  })

  test("openSession() does not kick off a session that already has a conversation root", async () => {
    await withHomeScope(async () => {
      stubConfig({ experimental: { boss_mode: true } })
      Provider.defaultModel = mock(async () => ({
        providerID: "test",
        modelID: "model",
      })) as typeof Provider.defaultModel
      const wakes: Array<[string, string]> = []
      SessionManager.scheduleWake = mock((sessionID: string, reason: string) => {
        wakes.push([sessionID, reason])
      }) as typeof SessionManager.scheduleWake
      SessionInbox.latestRootID = mock(async () => "msg_existing") as typeof SessionInbox.latestRootID

      const sessionID = await BossRuntime.openSession()
      const items = await SessionInbox.list(sessionID)
      expect(items.some((item) => item.deliveryKey?.startsWith("boss-open:"))).toBe(false)
      expect(wakes).toEqual([])
    })
  })
})
