import type { Event, EventSessionError, Session } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import type { SpaceIdentity } from "./space-state"
import { organizationRoute } from "../organization/route"
import { OrganizationNotificationProtocol as OrganizationNotice } from "@ericsanchezok/synergy-organization-protocol"

type SessionSummary = Pick<Session, "id" | "title" | "parentID">
type NotificationCopy = {
  responseReady: string
  sessionError: string
  errorFallback: string
}
export type OrganizationNotificationOrigin = {
  identity: Extract<SpaceIdentity, { kind: "organization" }>
  projectID: string
  name: string
}

export type ResolvedNotificationEvent = (
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
) & { organization?: OrganizationNotificationOrigin }

export function resolveOrganizationNotice(input: {
  notice: OrganizationNotice.Observation
  organization: OrganizationNotificationOrigin
  copy: NotificationCopy
}): ResolvedNotificationEvent | undefined {
  const parsed = OrganizationNotice.Observation.safeParse(input.notice)
  if (
    !parsed.success ||
    parsed.data.binding.orgID !== input.organization.identity.orgID ||
    parsed.data.binding.projectID !== input.organization.projectID
  )
    return
  const notice = parsed.data
  const organization = { ...input.organization, identity: { ...input.organization.identity } }
  const base = {
    sessionID: notice.sessionID,
    organization,
    description: organization.name,
    href: organizationRoute(organization.identity, organization.projectID, "", "sessions", notice.sessionID),
  }
  return notice.kind === "completion"
    ? { ...base, type: "turn-complete", title: input.copy.responseReady }
    : { ...base, type: "error", title: input.copy.sessionError, error: undefined }
}

export function resolveNotificationEvent(
  input: {
    event: Event
    session?: SessionSummary
    copy: NotificationCopy
  } & (
    | { organization: OrganizationNotificationOrigin; directory?: string }
    | { organization?: undefined; directory: string }
  ),
): ResolvedNotificationEvent | undefined {
  const organization = input.organization
    ? { ...input.organization, identity: { ...input.organization.identity } }
    : undefined
  const scopeHref = input.organization ? "" : `/${base64Encode(input.directory)}`
  const href = (sessionID?: string) =>
    organization
      ? organizationRoute(organization.identity, organization.projectID, "", "sessions", sessionID)
      : `${scopeHref}${sessionID ? `/session/${sessionID}` : ""}`

  switch (input.event.type) {
    case "session.completion": {
      if (input.session?.parentID) return undefined
      const sessionID = input.event.properties.sessionID
      return {
        type: "turn-complete",
        sessionID,
        title: input.copy.responseReady,
        description: organization?.name ?? input.session?.title ?? sessionID,
        href: href(sessionID),
        ...(organization ? { organization } : {}),
      }
    }
    case "session.error": {
      if (organization && !input.event.properties.sessionID) return undefined
      if (input.session?.parentID) return undefined
      const sessionID = input.event.properties.sessionID ?? "global"
      const error = input.event.properties.error
      return {
        type: "error",
        sessionID,
        error,
        title: input.copy.sessionError,
        description:
          organization?.name ?? input.session?.title ?? (typeof error === "string" ? error : input.copy.errorFallback),
        href: href(input.event.properties.sessionID),
        ...(organization ? { organization } : {}),
      }
    }
    default:
      return undefined
  }
}
