import type { Event, EventSessionError, Session } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"

type SessionSummary = Pick<Session, "id" | "title" | "parentID">
type NotificationCopy = {
  responseReady: string
  sessionError: string
  errorFallback: string
}

export type ResolvedNotificationEvent =
  | {
      type: "turn-complete"
      sessionID: string
      title: string
      description: string
      href: string
    }
  | {
      type: "error"
      sessionID: string
      error: EventSessionError["properties"]["error"]
      title: string
      description: string
      href: string
    }

export function resolveNotificationEvent(input: {
  directory: string
  event: Event
  session?: SessionSummary
  copy: NotificationCopy
}): ResolvedNotificationEvent | undefined {
  const scopeHref = `/${base64Encode(input.directory)}`

  switch (input.event.type) {
    case "session.completion": {
      if (input.session?.parentID) return undefined
      const sessionID = input.event.properties.sessionID
      return {
        type: "turn-complete",
        sessionID,
        title: input.copy.responseReady,
        description: input.session?.title ?? sessionID,
        href: `${scopeHref}/session/${sessionID}`,
      }
    }
    case "session.error": {
      if (input.session?.parentID) return undefined
      const sessionID = input.event.properties.sessionID ?? "global"
      const error = input.event.properties.error
      return {
        type: "error",
        sessionID,
        error,
        title: input.copy.sessionError,
        description: input.session?.title ?? (typeof error === "string" ? error : input.copy.errorFallback),
        href: input.event.properties.sessionID ? `${scopeHref}/session/${sessionID}` : scopeHref,
      }
    }
    default:
      return undefined
  }
}
