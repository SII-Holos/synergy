import { Agenda } from "@/agenda"
import { AgendaStore } from "@/agenda/store"
import { Config } from "@/config/config"
import { ExperienceRecall } from "@/library/experience-recall"
import { LibraryDB } from "@/library/database"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { externalIdentityHash } from "../channel/identity"
import { DEFAULT_IDENTITY_TEXT as DefaultIdentityText } from "./boss-prompt"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionInbox } from "../session/inbox"
import { SessionInteraction } from "../session/interaction"
import { SessionManager } from "../session/manager"
import { SessionNav } from "../session/nav"

/**
 * Runtime Boss Mode provisioning.
 *
 * When `experimental.boss_mode` is enabled, one runtime boss session is
 * created (idempotently) per enabled Feishu account, in home scope, with a
 * `scope:boss` endpoint key so all Feishu messages for that account route to
 * it. The boss receives a one-time "world overview" briefing (sessions,
 * projects, agenda, memory, experience, identity text) delivered as a steer
 * message with a deduplicated deliveryKey, and — when
 * `experimental.boss_briefing_interval_days` is set — an Agenda item
 * periodically re-injects a refresh instruction so the boss can re-perceive
 * its world after compaction.
 *
 * The total boss (home) and project bosses are peers; delegation flows
 * through `session_send`. Disabling the flag stops provisioning and routing
 * but never deletes or archives existing boss sessions.
 */
export namespace BossRuntime {
  const log = Log.create({ service: "boss.runtime" })

  export const BOSS_SCOPE_KEY = "boss"
  export const BOSS_CHAT_ID = "boss"
  export const BOSS_SESSION_TITLE = "Runtime Boss"
  export const BRIEFING_AGENDA_ID = "boss-briefing"
  const BRIEFING_DELIVERY_PREFIX = "boss-identity:"
  const BRIEFING_LIMIT = 50
  /** Per-account periodic briefing Agenda item ID (safe for storage paths). */
  export function briefingAgendaID(accountId: string): string {
    return `${BRIEFING_AGENDA_ID}-${externalIdentityHash(accountId).slice(0, 12)}`
  }

  /** Registered per-account boss sessions (accountId → sessionID). */
  const accountBossSessions = new Map<string, string>()

  /** Instruction text injected by the periodic Agenda item. */
  export const BRIEFING_REFRESH_PROMPT = [
    "周期世界概况刷新:请重新枚举当前 sessions、projects、agenda、memory(self/relationship) 与经验教训,",
    "更新你对这个 runtime 的认知。可调用 session_list / scope_list / agenda_list / memory_search 获取最新状态。",
    "重要事实请用 memory_write 固化(compaction 只折叠消息历史,memory 与 <boss-tree> 每轮重算存活)。",
  ].join("\n")

  /** Default colleague identity used when `boss_identity_text` is not set (owned by boss-prompt). */
  export const DEFAULT_IDENTITY_TEXT = DefaultIdentityText

  export function bossSessionForAccount(accountId: string): string | undefined {
    return accountBossSessions.get(accountId)
  }

  /**
   * Provision boss sessions for all enabled Feishu accounts and deliver the
   * one-time identity briefing. Idempotent: repeated calls reuse existing
   * sessions and the fixed deliveryKey prevents briefing re-delivery.
   */
  export async function ensure(): Promise<void> {
    const config = await Config.current().catch(() => undefined)
    const enabled = config?.experimental?.boss_mode === true
    // Reconcile: start from an empty routing map so removed accounts (or a
    // disabled mode) never leave stale entries behind. Re-provisioning is
    // idempotent per account (existing endpoint sessions are reused).
    accountBossSessions.clear()
    if (!enabled) return
    const feishu = config?.channel?.feishu
    if (!feishu) return
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Promise.all(
          Object.entries(feishu.accounts ?? {}).map(async ([accountId, account]) => {
            if (account.enabled === false) return
            if (account.projectDir) {
              log.warn("boss routing skipped for feishu account with projectDir (fail-closed)", {
                accountHash: externalIdentityHash(accountId),
              })
              return
            }
            const sessionID = await ensureBossSession(accountId)
            if (sessionID) accountBossSessions.set(accountId, sessionID)
          }),
        )
        await syncBriefingSchedule()
      },
    })
  }

  /** Hot-reload entry: enabled → ensure(); disabled → clear routing map only. */
  export async function sync(enabled: boolean): Promise<void> {
    if (enabled) {
      await ensure()
      return
    }
    accountBossSessions.clear()
    await removeBriefingSchedule()
  }

  /**
   * Re-deliver the identity briefing to every registered boss session.
   * Pass `versioned: true` to force re-delivery (identity text change, or
   * periodic snapshot); the default fixed deliveryKey keeps startup idempotent.
   */
  export async function refreshIdentity(options?: { versioned?: boolean }): Promise<void> {
    if (accountBossSessions.size === 0) return
    const config = await Config.current().catch(() => undefined)
    const identityText = config?.experimental?.boss_identity_text?.trim() || DEFAULT_IDENTITY_TEXT
    for (const sessionID of accountBossSessions.values()) {
      await deliverBriefing(sessionID, identityText, { versioned: options?.versioned === true })
    }
  }

  /** Re-register the periodic briefing Agenda item from current config (interval changes). */
  export async function rescheduleBriefing(): Promise<void> {
    await syncBriefingSchedule()
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async function ensureBossSession(accountId: string): Promise<string | undefined> {
    const endpoint = SessionEndpoint.fromChannel({
      type: "feishu",
      accountId,
      chatId: BOSS_CHAT_ID,
      chatType: "group",
      chatName: BOSS_SESSION_TITLE,
      scopeKey: BOSS_SCOPE_KEY,
      createdAt: Date.now(),
    })
    const existing = await SessionManager.getSession(endpoint)
    if (existing) {
      if (existing.workflow?.kind !== "boss" || existing.workflow.role !== "boss") {
        await Session.update(existing.id, (draft) => {
          draft.workflow = { kind: "boss", role: "boss" }
        })
        log.info("promoted existing endpoint session to runtime boss", {
          sessionID: existing.id,
          accountHash: externalIdentityHash(accountId),
        })
      }
      if (existing.agentOverride !== "boss-synergy") {
        await Session.update(existing.id, (draft) => {
          draft.agentOverride = "boss-synergy"
        })
        log.info("upgraded runtime boss session to boss-synergy agent", {
          sessionID: existing.id,
          accountHash: externalIdentityHash(accountId),
        })
      }
      await deliverIdentityBriefing(existing.id)
      return existing.id
    }
    const session = await Session.create({
      scope: Scope.home(),
      endpoint,
      interaction: SessionInteraction.interactive("boss"),
      title: BOSS_SESSION_TITLE,
      agentOverride: "boss-synergy",
      workflow: { kind: "boss", role: "boss" },
    })
    log.info("runtime boss session created", {
      sessionID: session.id,
      accountHash: externalIdentityHash(accountId),
    })
    await deliverIdentityBriefing(session.id)
    return session.id
  }

  /** One-time briefing: fixed deliveryKey dedupes across restarts. */
  async function deliverIdentityBriefing(sessionID: string): Promise<void> {
    const identityText = (await Config.current().catch(() => undefined))?.experimental?.boss_identity_text?.trim()
    await deliverBriefing(sessionID, identityText || DEFAULT_IDENTITY_TEXT, { versioned: false })
  }

  async function deliverBriefing(
    sessionID: string,
    identityText: string,
    options: { versioned: boolean },
  ): Promise<void> {
    const text = await buildBossIdentityBriefing(identityText).catch((error) => {
      log.warn("failed to build boss identity briefing", { sessionID, error })
      return `身份简报生成失败:${error instanceof Error ? error.message : String(error)}`
    })
    const deliveryKey = options.versioned
      ? `${BRIEFING_DELIVERY_PREFIX}${sessionID}:${Date.now()}`
      : `${BRIEFING_DELIVERY_PREFIX}${sessionID}`
    await SessionInbox.deliverUnique({
      sessionID,
      deliveryKey,
      mode: "steer",
      message: {
        role: "user",
        origin: { type: "system", detail: "boss_identity" },
        visible: true,
        parts: [{ type: "text", text }],
        summary: { title: "Runtime world overview" },
      },
    })
  }

  /**
   * Build the world-overview briefing: identity text + bounded enumerations of
   * sessions, projects, agenda, identity memory, and experience lessons.
   * Pure-ish (reads durable stores) and unit-testable.
   */
  export async function buildBossIdentityBriefing(identityText: string): Promise<string> {
    const [sessions, scopes, agenda, memories, experiences] = await Promise.all([
      withTimeout(SessionNav.queryGlobal({ parentOnly: false, limit: BRIEFING_LIMIT }), 3_000).catch(() => undefined),
      withTimeout(Scope.list(), 3_000).catch(() => []),
      withTimeout(AgendaStore.listAll(), 3_000).catch(() => []),
      withTimeout(Promise.resolve(LibraryDB.Memory.listByCategories(["self", "relationship"])), 3_000).catch(() => []),
      withTimeout(ExperienceRecall.retrieve(undefined, "identity lessons", { topK: 5 }), 3_000).catch(() => []),
    ])

    const lines: string[] = [
      "<boss-world-overview>",
      `# Runtime 世界概况(生成于 ${new Date().toISOString()})`,
      "",
      "## 身份",
      identityText.trim(),
    ]

    const projectLines = scopes
      .slice(0, BRIEFING_LIMIT)
      .map((s) => `- ${s.name ?? s.id} (${s.id}, 目录: ${s.directory})`)
    lines.push("", `## 项目 (${scopes.length}${scopes.length > BRIEFING_LIMIT ? `, 显示前 ${BRIEFING_LIMIT}` : ""})`)
    lines.push(...(projectLines.length > 0 ? projectLines : ["- (无)"]))

    const sessionLines = (sessions?.items ?? []).map(
      (e) => `- [${e.category}] ${e.title} (${e.id}, scope: ${e.scopeID})`,
    )
    lines.push(
      "",
      `## 会话 (${sessions?.total ?? 0}${(sessions?.total ?? 0) > BRIEFING_LIMIT ? `, 显示前 ${BRIEFING_LIMIT}` : ""})`,
    )
    lines.push(...(sessionLines.length > 0 ? sessionLines : ["- (无)"]))

    const agendaLines = agenda.map((a) => {
      const next = a.state.nextRunAt ? new Date(a.state.nextRunAt).toISOString() : "无"
      return `- ${a.title} (next: ${next})`
    })
    lines.push("", `## 议程 (${agenda.length})`)
    lines.push(...(agendaLines.length > 0 ? agendaLines : ["- (无)"]))

    const memoryLines = memories.map((m) => `- [${m.category}] ${m.title}: ${m.content.slice(0, 120)}`)
    lines.push("", `## 身份记忆 (self/relationship, ${memories.length})`)
    lines.push(...(memoryLines.length > 0 ? memoryLines : ["- (无)"]))

    const experienceLines = experiences.map(
      (e) => `- ${e.intent} (score: ${e.score.toFixed(2)}, session: ${e.sessionID})`,
    )
    lines.push("", `## 经验教训 (top ${experiences.length})`)
    lines.push(...(experienceLines.length > 0 ? experienceLines : ["- (无)"]))

    lines.push(
      "",
      "超出上限时请用 session_list / scope_list / agenda_list / memory_search 深查。",
      "</boss-world-overview>",
    )
    return lines.join("\n")
  }

  /** Register or update one periodic briefing Agenda item per boss account. */
  async function syncBriefingSchedule(): Promise<void> {
    const config = await Config.current().catch(() => undefined)
    const days = config?.experimental?.boss_briefing_interval_days
    if (!days) {
      await removeBriefingSchedule()
      return
    }
    // Migrate the legacy single-account item (pre-multi-account) away.
    await Agenda.remove(BRIEFING_AGENDA_ID).catch(() => undefined)
    const entries = [...accountBossSessions.entries()]
    if (entries.length === 0) return
    for (const [accountId, sessionID] of entries) {
      const itemID = briefingAgendaID(accountId)
      try {
        const existing = await AgendaStore.get("home", itemID).catch(() => undefined)
        if (existing) {
          await Agenda.update(itemID, {
            prompt: BRIEFING_REFRESH_PROMPT,
            triggers: [{ type: "every", interval: `${days}d` }],
          })
          log.info("boss briefing agenda item updated", { id: itemID, days, sessionID })
          continue
        }
        await Agenda.create(
          {
            title: "Runtime Boss 世界概况刷新",
            prompt: BRIEFING_REFRESH_PROMPT,
            triggers: [{ type: "every", interval: `${days}d` }],
            deliveryMode: "session_guidance",
            sessionID,
            global: true,
            tags: ["system"],
            createdBy: "agent",
          },
          itemID,
        )
        log.info("boss briefing agenda item created", { id: itemID, days, sessionID })
      } catch (error) {
        log.warn("failed to sync boss briefing agenda item", { id: itemID, error })
      }
    }
  }

  async function removeBriefingSchedule(): Promise<void> {
    const items = await AgendaStore.listAll().catch(() => [])
    const briefingItems = items.filter(
      (item) => item.id === BRIEFING_AGENDA_ID || item.id.startsWith(`${BRIEFING_AGENDA_ID}-`),
    )
    for (const item of briefingItems) {
      try {
        await Agenda.remove(item.id)
        log.info("boss briefing agenda item removed", { id: item.id })
      } catch {
        // Not present — fine.
      }
    }
  }
}
