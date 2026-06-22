import { withTimeout } from "@/util/timeout"
import { Identifier } from "../id/id"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import { Session } from "../session"
import { SessionInvoke } from "../session/invoke"
import { AgendaStore } from "./store"
import { SessionInteraction } from "../session/interaction"
import { AgendaDelivery } from "./delivery"
import { AgendaPrompt } from "./prompt"
import { AgendaTypes } from "./types"
import { Plugin } from "../plugin"
import { Log } from "../util/log"

export namespace AgendaReactor {
  const log = Log.create({ service: "agenda.reactor" })
  const DEFAULT_TIMEOUT = 6 * 60 * 60 * 1000

  export interface Result {
    nextRunAt: number | undefined
    sessionID: string | undefined
    deactivated?: boolean
  }

  export async function execute(signal: AgendaTypes.FiredSignal, scopeID: string): Promise<Result> {
    try {
      return await run(signal, scopeID)
    } catch (err) {
      log.error("execute failed", { itemID: signal.source, error: err instanceof Error ? err : new Error(String(err)) })
      // Compute a fallback nextRunAt so the clock entry is not permanently
      // deleted. If the item cannot be read, return undefined as a last resort.
      const nextRunAt = await AgendaStore.get(scopeID, signal.source)
        .then((item) => AgendaStore.computeNextRunAt(item.triggers))
        .catch(() => undefined)
      return { nextRunAt, sessionID: undefined }
    }
  }

  async function run(signal: AgendaTypes.FiredSignal, scopeID: string): Promise<Result> {
    const storedItem = await AgendaStore.get(scopeID, signal.source).catch(
      () => undefined as AgendaTypes.Item | undefined,
    )
    if (!storedItem || storedItem.status !== "active") {
      log.info("skipped", { itemID: signal.source, reason: !storedItem ? "not found" : `status=${storedItem.status}` })
      return { nextRunAt: undefined, sessionID: undefined }
    }

    const scope = storedItem.origin.scope ?? Scope.global()
    return Instance.provide({ scope, fn: () => runInScope(storedItem, signal, scopeID, scope) })
  }

  async function runInScope(
    storedItem: AgendaTypes.Item,
    signal: AgendaTypes.FiredSignal,
    scopeID: string,
    scope: Scope,
  ): Promise<Result> {
    let before: { skip: boolean; item: AgendaTypes.Item }
    try {
      before = await Plugin.trigger(
        "agenda.run.before",
        {
          signal,
          item: storedItem,
          scopeID,
        },
        {
          skip: false,
          item: storedItem,
        },
      )
    } catch (err) {
      log.error("agenda.run.before plugin failed", {
        itemID: storedItem.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
      before = { skip: false, item: storedItem }
    }
    if (before.skip) {
      log.info("skipped by plugin", { itemID: storedItem.id, signalType: signal.type })
      return { nextRunAt: AgendaStore.computeNextRunAt(storedItem.triggers), sessionID: undefined }
    }

    const item = before.item

    if (item.state.consecutiveErrors >= 5) {
      log.warn("auto-pausing item due to consecutive errors", {
        itemID: item.id,
        consecutiveErrors: item.state.consecutiveErrors,
      })
      await AgendaStore.update(scopeID, item.id, { status: "paused" })
      return { nextRunAt: undefined, sessionID: undefined, deactivated: true }
    }

    // -----------------------------------------------------------------------
    // Execute — autoDone items deliver directly, others create a new session
    // -----------------------------------------------------------------------

    const startTime = Date.now()
    let sessionID: string | undefined
    let error: Error | undefined
    let lastMessage: string | undefined

    if (item.autoDone) {
      // Direct delivery to origin session — no new session, no invoke.
      // Used by agenda_watch: the prompt IS the message the agent sees.
      log.info("autoDone item fired — direct delivery, no new session", { itemID: item.id })
      lastMessage = item.prompt
    } else {
      // Normal path — create session, run prompt via SessionInvoke
      const sessionMode = AgendaTypes.inferSessionMode(item.triggers, item.sessionMode)
      const persistent = sessionMode === "persistent"

      await Instance.provide({
        scope,
        fn: async () => {
          sessionID = persistent
            ? await resolveOrCreateSession(item, scope, scopeID)
            : await createEphemeralSession(item, scope)

          const promptText = AgendaPrompt.build(item, signal)

          try {
            await withTimeout(
              SessionInvoke.invoke({
                sessionID: sessionID!,
                agent: item.agent,
                model: item.model,
                parts: [{ type: "text", text: promptText }],
              }),
              item.timeout ?? DEFAULT_TIMEOUT,
            )
          } catch (err) {
            error = err instanceof Error ? err : new Error(String(err))
          }
        },
      })

      if (sessionID && !error) {
        lastMessage = await extractLastAssistantMessage(sessionID)
      }
      // Archive ephemeral sessions so they don't accumulate in the session list.
      // Do this after extracting the last message but before state management.
      if (sessionID && !persistent) {
        await Session.update(sessionID, (draft) => {
          draft.time.archived = Date.now()
        }).catch((err) => {
          log.warn("failed to archive ephemeral session", {
            sessionID,
            error: err instanceof Error ? err : new Error(String(err)),
          })
        })
      }
    }

    const duration = Date.now() - startTime

    // -----------------------------------------------------------------------
    // State management — always runs, regardless of autoDone
    // -----------------------------------------------------------------------

    const runLog: AgendaTypes.RunLog = {
      id: Identifier.ascending("agenda"),
      itemID: item.id,
      status: error ? "error" : "ok",
      trigger: { type: signal.type, source: signal.source },
      sessionID,
      error: error?.message,
      duration,
      time: { started: startTime, completed: startTime + duration },
    }

    await AgendaStore.appendRun(scopeID, runLog).catch((err) => {
      log.error("failed to append run", {
        itemID: item.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })

    let nextRunAt: number | undefined
    try {
      const result = await AgendaStore.updateRunState(
        scopeID,
        item.id,
        {
          status: error ? "error" : "ok",
          error: error?.message,
          sessionID,
          startTime,
          duration,
        },
        item.triggers,
        signal.type,
      )
      nextRunAt = result.nextRunAt
    } catch (err) {
      log.error("failed to update item state", {
        itemID: item.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
      nextRunAt = AgendaStore.computeNextRunAt(item.triggers)
    }

    // -----------------------------------------------------------------------
    // Plugin hooks — always fire
    // -----------------------------------------------------------------------

    try {
      if (error) {
        await Plugin.trigger("agenda.run.error", { signal, item, scopeID, error: error.message, sessionID }, {})
      } else {
        await Plugin.trigger("agenda.run.after", { signal, item, run: runLog, scopeID }, {})
      }
    } catch (err) {
      log.error("agenda.run plugin hook failed", {
        itemID: item.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }

    // -----------------------------------------------------------------------
    // Delivery — send result/prompt to origin session
    // -----------------------------------------------------------------------

    if (!error) {
      const sourceSessionID = sessionID ?? item.origin.sessionID ?? ""
      await AgendaDelivery.deliver({ item, sessionID: sourceSessionID, lastMessage }).catch((err) => {
        log.error("delivery failed", { itemID: item.id, error: err instanceof Error ? err : new Error(String(err)) })
      })
    }

    return { nextRunAt, sessionID }
  }

  async function createEphemeralSession(item: AgendaTypes.Item, scope: Scope): Promise<string> {
    // Append a short date to the title so ephemeral sessions are easy to
    // identify in the session list. Use the cron/every trigger's timezone if
    // available, otherwise fall back to UTC.
    const cronTrigger = item.triggers.find(
      (t): t is AgendaTypes.Trigger & { type: "cron"; tz?: string } => t.type === "cron",
    )
    const tz = cronTrigger?.tz
    const date = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())
    const session = await Session.create({
      scope,
      title: `Agenda: ${item.title} ${date}`,
      agenda: { itemID: item.id },
      interaction: SessionInteraction.unattended("agenda"),
    })
    return session.id
  }

  async function resolveOrCreateSession(item: AgendaTypes.Item, scope: Scope, scopeID: string): Promise<string> {
    const existing = item.state.persistentSessionID
    if (existing) {
      const valid = await Session.get(existing)
        .then(() => true)
        .catch(() => false)
      if (valid) return existing
    }

    const sessionID = await createEphemeralSession(item, scope)
    await AgendaStore.setPersistentSession(scopeID, item.id, sessionID)
    return sessionID
  }

  async function extractLastAssistantMessage(sessionID: string): Promise<string | undefined> {
    try {
      const messages = await Session.messages({ sessionID })
      const assistantMessage = messages.findLast((msg) => msg.info.role === "assistant")
      if (!assistantMessage) return undefined
      const textParts = assistantMessage.parts.filter((part) => part.type === "text").map((part) => part.text)
      if (textParts.length > 0) return textParts.join("\n")
    } catch (err) {
      log.error("failed to extract last message", {
        sessionID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
    return undefined
  }
}
