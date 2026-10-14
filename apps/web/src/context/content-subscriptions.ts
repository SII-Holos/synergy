import type { Event, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

export type ContentSummaryProperties = Extract<Event, { type: "message.part.summary" }>["properties"] & {
  discovery?: true
}

export function projectContentSummary(
  subscriptions: ReturnType<typeof createContentSubscriptions>,
  scopeID: string,
  properties: ContentSummaryProperties,
  seq?: number,
): ContentSummaryProperties | undefined {
  const summaryAccepted = subscriptions.acceptsSummary(scopeID, properties)
  if (subscriptions.accept(scopeID, properties)) return properties
  if (properties.content?.kind === "append" || properties.content?.kind === "anchor") return
  if (seq === undefined && !summaryAccepted) return { summary: properties.summary, discovery: true }
  return { summary: properties.summary }
}

type Interest = {
  scopeID: string
  sessionID: string
  messageID: string
  partID: string
  generation: number
  version?: string
}
type Active = { scopeID: string; sessionID: string; generation: number }
type Detail = {
  kind: string
  scopeID: string
  sessionID: string
  generation: number
  runID?: string
  nodeIDs?: string[]
}
type State = { generation: number; parts: Interest[]; active?: Active; details: Detail[] }
const keyOf = (scopeID: string, messageID: string, partID: string) => `${scopeID}\0${messageID}\0${partID}`

export function createContentSubscriptions(send: (state: State) => void, changed: () => void = () => {}) {
  const interests = new Map<string, { interest: Interest; consumers: number; settled?: number }>()
  const versions = new Map<string, string>()
  const streams = new Map<string, { id: string; offset: number; revision: number }>()
  const details = new Map<string, { interest: Detail; consumers: number }>()
  let projected: Detail[] = []
  let publication = 0
  let generation = 0
  let active: Active | undefined
  let hidden = false
  const current = (): State =>
    hidden
      ? { generation: publication, parts: [], details: [] }
      : {
          generation: publication,
          parts: [...interests.values()].map((entry) => entry.interest),
          active,
          details: projected,
        }
  const publish = () => {
    const groups = new Map<string, Detail[]>()
    for (const { interest } of details.values()) {
      const key = JSON.stringify([interest.kind, interest.scopeID, interest.sessionID])
      const group = groups.get(key) ?? []
      group.push(interest)
      groups.set(key, group)
    }
    projected = [...groups.values()].map((group) => {
      const first = group[0]
      const prior = projected.find(
        (item) => item.kind === first.kind && item.scopeID === first.scopeID && item.sessionID === first.sessionID,
      )
      const merged = {
        ...first,
        runID: group.every((item) => item.runID === first.runID) ? first.runID : undefined,
        nodeIDs: group.every((item) => item.nodeIDs)
          ? [...new Set(group.flatMap((item) => item.nodeIDs!))].sort()
          : undefined,
      }
      const next = Math.max(...group.map((item) => item.generation))
      const equal =
        prior && prior.runID === merged.runID && JSON.stringify(prior.nodeIDs) === JSON.stringify(merged.nodeIDs)
      return { ...merged, generation: equal && next <= prior.generation ? prior.generation : ++generation }
    })
    publication++
    send(current())
    changed()
  }
  const renew = () => {
    versions.clear()
    streams.clear()
    for (const entry of details.values()) entry.interest = { ...entry.interest, generation: ++generation }
    for (const entry of interests.values()) entry.interest = { ...entry.interest, generation: ++generation }
    if (active) active = { ...active, generation: ++generation }
  }
  return {
    current,
    pending(scopeID: string, sessionID: string) {
      for (const { interest, settled } of interests.values())
        if (interest.scopeID === scopeID && interest.sessionID === sessionID && settled !== interest.generation)
          return true
      return false
    },
    settle(scopeID: string, properties: { summary: SessionPartSummary; subscription?: number }) {
      const entry = interests.get(keyOf(scopeID, properties.summary.messageID, properties.summary.id))
      if (
        !entry ||
        hidden ||
        properties.summary.sessionID !== entry.interest.sessionID ||
        properties.subscription !== entry.interest.generation
      )
        return
      if (entry.settled === entry.interest.generation) return
      entry.settled = entry.interest.generation
      changed()
    },
    view(input: Omit<Detail, "generation">) {
      const key = JSON.stringify(input)
      let entry = details.get(key)
      if (!entry) {
        entry = { interest: { ...input, generation: ++generation }, consumers: 0 }
        details.set(key, entry)
      }
      entry.consumers++
      publish()
      let released = false
      return () => {
        if (released) return
        released = true
        if (--entry.consumers === 0) {
          details.delete(key)
          publish()
        }
      }
    },
    renewView(scopeID: string, sessionID: string, kind: string) {
      for (const entry of details.values())
        if (
          entry.interest.scopeID === scopeID &&
          entry.interest.sessionID === sessionID &&
          entry.interest.kind === kind
        )
          entry.interest = { ...entry.interest, generation: ++generation }
      publish()
    },
    acceptsView(scopeID: string, sessionID: string, kind: string, generation: number) {
      return (
        !hidden &&
        projected.some(
          (entry) =>
            entry.scopeID === scopeID &&
            entry.sessionID === sessionID &&
            entry.kind === kind &&
            entry.generation === generation,
        )
      )
    },
    retain(scopeID: string, part: SessionPartSummary, cached = false) {
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
            version: cached ? part.content.version : undefined,
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
          streams.delete(key)
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
      for (const key of versions.keys())
        if (!interests.has(key)) {
          versions.delete(key)
          streams.delete(key)
        }
      publish()
    },
    renewPart(scopeID: string, properties: ContentSummaryProperties) {
      const key = keyOf(scopeID, properties.summary.messageID, properties.summary.id)
      const entry = interests.get(key)
      versions.delete(key)
      streams.delete(key)
      if (entry) entry.interest = { ...entry.interest, generation: ++generation }
      else if (active?.scopeID === scopeID && active.sessionID === properties.summary.sessionID)
        active = { ...active, generation: ++generation }
      publish()
    },
    acceptsSummary(
      scopeID: string,
      properties: { summary: SessionPartSummary; subscription?: number; content?: unknown; stream?: unknown },
    ) {
      if (!properties.content && !properties.stream) return true
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
        content?: {
          kind: string
          baseVersion?: string
          delta?: string
          streamID?: string
          offset?: number
          revision?: number
        }
        stream?: { id: string; offset: number; revision: number }
      },
    ) {
      if (!properties.content && !properties.stream) return true
      const part = properties.summary
      const key = keyOf(scopeID, part.messageID, part.id)
      const wanted = interests.get(key)?.interest
      const implicit =
        !wanted && active?.scopeID === scopeID && active.sessionID === part.sessionID ? active : undefined
      if (hidden || properties.subscription !== (wanted ?? implicit)?.generation) return false
      const stream = streams.get(key)
      const content = properties.content
      if (!content) {
        if (!properties.stream || wanted?.version !== part.content.version) return false
        streams.set(key, properties.stream)
        versions.set(key, part.content.version)
        return true
      }
      const gap =
        (content.kind === "append" || content.kind === "anchor") &&
        (!stream ||
          stream.id !== content.streamID ||
          stream.offset !== content.offset ||
          stream.revision + 1 !== content.revision)
      if (gap || (content.kind === "delta" && versions.get(key) !== content.baseVersion)) {
        versions.delete(key)
        streams.delete(key)
        if (wanted) {
          interests.get(key)!.interest = { ...wanted, generation: ++generation }
          publish()
        } else if (implicit) {
          active = { ...implicit, generation: ++generation }
          publish()
        }
        return false
      }
      if ((content.kind === "append" || content.kind === "anchor") && stream)
        streams.set(key, {
          id: stream.id,
          offset: stream.offset + (content.delta?.length ?? 0),
          revision: content.revision!,
        })
      else if (content.kind === "checkpoint" && properties.stream) streams.set(key, properties.stream)
      else streams.delete(key)
      versions.delete(key)
      versions.set(key, part.content.version)
      if (versions.size > 4096)
        for (const candidate of versions.keys()) {
          if (!interests.has(candidate)) {
            versions.delete(candidate)
            streams.delete(candidate)
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
