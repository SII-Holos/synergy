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
      return { nextRunAt: undefined, sessionID: undefined }
    }
  }

  async function run(signal: AgendaTypes.FiredSignal, scopeID: string): Promise<Result> {
    const item = await AgendaStore.get(scopeID, signal.source).catch(() => undefined as AgendaTypes.Item | undefined)
    if (!item || item.status !== "active") {
      log.info("skipped", { itemID: signal.source, reason: !item ? "not found" : `status=${item.status}` })
      return { nextRunAt: undefined, sessionID: undefined }
    }

    if (item.state.consecutiveErrors >= 5) {
      log.warn("auto-pausing item due to consecutive errors", {
        itemID: item.id,
        consecutiveErrors: item.state.consecutiveErrors,
      })
      await AgendaStore.update(scopeID, item.id, { status: "paused" })
      return { nextRunAt: undefined, sessionID: undefined, deactivated: true }
    }

    const scope = item.task?.workScope ?? Scope.global()
    const persistent = item.task?.sessionMode === "persistent"
    const startTime = Date.now()
    let sessionID: string | undefined
    let error: Error | undefined

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
              agent: item.task?.agent,
              model: item.task?.model,
              parts: [{ type: "text", text: promptText }],
            }),
            item.task?.timeout ?? DEFAULT_TIMEOUT,
          )
        } catch (err) {
          error = err instanceof Error ? err : new Error(String(err))
        }
      },
    })

    const duration = Date.now() - startTime

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

    const { nextRunAt } = await AgendaStore.updateRunState(
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
    ).catch((err) => {
      log.error("failed to update item state", {
        itemID: item.id,
        error: err instanceof Error ? err : new Error(String(err)),
      })
      return { nextRunAt: undefined }
    })

    if (sessionID && !error) {
      await deliverResult(item, sessionID).catch((err) => {
        log.error("delivery failed", { itemID: item.id, error: err instanceof Error ? err : new Error(String(err)) })
      })
    }

    return { nextRunAt, sessionID }
  }

  async function createEphemeralSession(item: AgendaTypes.Item, scope: Scope): Promise<string> {
    const session = await Session.create({
      scope,
      title: "Agenda: " + item.title,
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

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
    if (!timeoutMs) return promise
    let timer: Timer
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Execution timed out")), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
  }

  async function deliverResult(item: AgendaTypes.Item, sessionID: string): Promise<void> {
    const lastMessage = await extractLastAssistantMessage(sessionID)
    await AgendaDelivery.deliver({ item, sessionID, lastMessage })
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
