import type { Event, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

export type ContentSummaryProperties = Extract<Event, { type: "message.part.summary" }>["properties"] & {
  discovery?: true
}

export function projectContentSummary(
  subscriptions: ReturnType<typeof createContentSubscriptions>,
  scopeID: string,
  properties: ContentSummaryProperties,
  seq?: number,
): ContentSummaryProperties {
  const summaryAccepted = subscriptions.acceptsSummary(scopeID, properties)
  if (subscriptions.accept(scopeID, properties)) return properties
  if (seq === undefined && !summaryAccepted) return { summary: properties.summary, discovery: true }
  return { summary: properties.summary }
}

type Interest = { scopeID: string; sessionID: string; messageID: string; partID: string; generation: number }
type Active = { scopeID: string; sessionID: string; generation: number }
type State = { parts: Interest[]; active?: Active }
const keyOf = (scopeID: string, messageID: string, partID: string) => `${scopeID}\0${messageID}\0${partID}`

export function createContentSubscriptions(send: (state: State) => void) {
  const interests = new Map<string, { interest: Interest; consumers: number }>()
  const versions = new Map<string, string>()
  let generation = 0
  let active: Active | undefined
  let hidden = false
  const current = (): State =>
    hidden ? { parts: [] } : { parts: [...interests.values()].map((entry) => entry.interest), active }
  const publish = () => send(current())
  const renew = () => {
    versions.clear()
    for (const entry of interests.values()) entry.interest = { ...entry.interest, generation: ++generation }
    if (active) active = { ...active, generation: ++generation }
  }
  return {
    current,
    retain(scopeID: string, part: SessionPartSummary) {
      const key = keyOf(scopeID, part.messageID, part.id)
      let entry = interests.get(key)
      if (!entry) {
        entry = {
          interest: {
            scopeID,
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            generation: ++generation,
          },
          consumers: 0,
        }
        interests.set(key, entry)
      }
      entry.consumers++
      publish()
      let released = false
      return () => {
        if (released) return
        released = true
        entry!.consumers--
        if (!entry!.consumers && interests.get(key) === entry) {
          interests.delete(key)
          versions.delete(key)
          publish()
        }
      }
    },
    active(scopeID: string, sessionID?: string) {
      if (active?.scopeID === scopeID && active.sessionID === sessionID) return
      active = sessionID
        ? { scopeID, sessionID, generation: ++generation }
        : active?.scopeID === scopeID
          ? undefined
          : active
      for (const key of versions.keys()) if (!interests.has(key)) versions.delete(key)
      publish()
    },
    acceptsSummary(
      scopeID: string,
      properties: { summary: SessionPartSummary; subscription?: number; content?: unknown },
    ) {
      if (!properties.content) return true
      const part = properties.summary
      const wanted = interests.get(keyOf(scopeID, part.messageID, part.id))?.interest
      const implicit =
        !wanted && active?.scopeID === scopeID && active.sessionID === part.sessionID ? active : undefined
      return !hidden && properties.subscription === (wanted ?? implicit)?.generation
    },
    accept(
      scopeID: string,
      properties: {
        summary: SessionPartSummary
        subscription?: number
        content?: { kind: string; baseVersion?: string; delta?: string }
      },
    ) {
      if (!properties.content) return true
      const part = properties.summary
      const key = keyOf(scopeID, part.messageID, part.id)
      const wanted = interests.get(key)?.interest
      const implicit =
        !wanted && active?.scopeID === scopeID && active.sessionID === part.sessionID ? active : undefined
      if (hidden || properties.subscription !== (wanted ?? implicit)?.generation) return false
      if (properties.content.kind === "delta" && versions.get(key) !== properties.content.baseVersion) {
        versions.delete(key)
        if (wanted) {
          interests.get(key)!.interest = { ...wanted, generation: ++generation }
          publish()
        } else if (implicit) {
          active = { ...implicit, generation: ++generation }
          publish()
        }
        return false
      }
      versions.delete(key)
      versions.set(key, part.content.version)
      if (versions.size > 4096)
        for (const candidate of versions.keys()) {
          if (!interests.has(candidate)) {
            versions.delete(candidate)
            break
          }
        }
      return true
    },
    hidden(value: boolean) {
      if (hidden === value) return
      hidden = value
      if (!hidden) renew()
      publish()
    },
    reconnect() {
      renew()
      publish()
    },
  }
}
