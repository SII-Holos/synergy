import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { PermissionNext } from "../permission/next"
import { Question } from "../question"
import { ScopeContext } from "../scope/context"
import { SessionEvent } from "../session/event"
import { SessionManager } from "../session/manager"
import type { Info as SessionInfo } from "../session/types"
import { PushService } from "./service"
import type { PushTypes } from "./types"

export namespace PushBridge {
  const log = Log.create({ service: "push.bridge" })

  const MAX_BODY_LENGTH = 200

  const inflight = new Set<Promise<unknown>>()
  let disposeActive: (() => void) | undefined

  /** Await all in-flight fan-outs (deterministic tests, graceful shutdown). */
  export async function flush(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }

  export function init(): () => void {
    if (disposeActive) return disposeActive

    const publish = (payload: PushTypes.Payload) => {
      const task = PushService.send(payload).catch((error) => log.warn("push send failed", { error }))
      inflight.add(task)
      void task.finally(() => inflight.delete(task))
    }

    const truncate = (body: string): string =>
      body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH - 1) + "…" : body

    // Mirrors the Web app's notification-event.ts href contract: the scope
    // token is "home" for the home scope, otherwise the scope directory.
    const scopeToken = (session: SessionInfo): string =>
      session.scope.type === "home" ? "home" : (session.scope.directory ?? "home")

    const sessionHref = (session: SessionInfo): string => `/${base64Encode(scopeToken(session))}/session/${session.id}`

    const resolveSession = async (sessionID: string | undefined): Promise<SessionInfo | undefined> => {
      if (!sessionID) return undefined
      return SessionManager.getSession(sessionID).catch(() => undefined)
    }

    // Channel-endpoint sessions deliver through their own channel surface
    // (outbound bridge / question cards); completion/error additionally skip
    // child sessions to mirror the in-app notification rules.
    const skip = (session: SessionInfo, category: "completion" | "error" | "input"): boolean => {
      if (session.endpoint?.kind === "channel") return true
      if (category !== "input" && session.parentID) return true
      return false
    }

    const unsubscribers = [
      Bus.subscribeGlobal(SessionEvent.Completion, (event) => {
        const task = (async () => {
          const session = await resolveSession(event.properties.sessionID)
          if (!session || skip(session, "completion")) return
          publish({
            title: "Response ready",
            body: truncate(session.title),
            href: sessionHref(session),
            tag: `session-${session.id}`,
            category: "completion",
            badge: event.properties.unreadCount,
          })
        })().catch((error) => log.warn("completion push failed", { error }))
        inflight.add(task)
        void task.finally(() => inflight.delete(task))
      }),
      Bus.subscribeGlobal(SessionEvent.Error, (event) => {
        const task = (async () => {
          const sessionID = event.properties.sessionID
          if (!sessionID) {
            // Truly global errors (no session context) fall back to the
            // current scope root; unresolved session-scoped errors stay
            // silent instead of leaking raw error text as a global push.
            const scope = ScopeContext.current.scope
            const directory = scope.type === "home" ? "home" : (scope.directory ?? "home")
            publish({
              title: "Session error",
              body: truncate(typeof event.properties.error === "string" ? event.properties.error : "Session error"),
              href: `/${base64Encode(directory)}`,
              tag: "session-global",
              category: "error",
            })
            return
          }
          const session = await resolveSession(sessionID)
          if (!session || skip(session, "error")) return
          const error = event.properties.error
          publish({
            title: "Session error",
            body: truncate(session.title ?? (typeof error === "string" ? error : "Session error")),
            href: sessionHref(session),
            tag: `session-${session.id}`,
            category: "error",
          })
        })().catch((error) => log.warn("error push failed", { error }))
        inflight.add(task)
        void task.finally(() => inflight.delete(task))
      }),
      Bus.subscribeGlobal(Question.Event.Asked, (event) => {
        const task = (async () => {
          const session = await resolveSession(event.properties.sessionID)
          if (!session || skip(session, "input")) return
          publish({
            title: "Session needs your input",
            body: truncate(session.title),
            href: sessionHref(session),
            tag: `input-${session.id}`,
            category: "input",
          })
        })().catch((error) => log.warn("question push failed", { error }))
        inflight.add(task)
        void task.finally(() => inflight.delete(task))
      }),
      Bus.subscribeGlobal(PermissionNext.Event.Asked, (event) => {
        const task = (async () => {
          const session = await resolveSession(event.properties.sessionID)
          if (!session || skip(session, "input")) return
          publish({
            title: "Session needs your input",
            body: truncate(session.title),
            href: sessionHref(session),
            tag: `input-${session.id}`,
            category: "input",
          })
        })().catch((error) => log.warn("permission push failed", { error }))
        inflight.add(task)
        void task.finally(() => inflight.delete(task))
      }),
    ]

    const dispose = () => {
      if (disposeActive !== dispose) return
      for (const unsubscribe of unsubscribers) unsubscribe()
      disposeActive = undefined
    }
    disposeActive = dispose
    return dispose
  }
}
