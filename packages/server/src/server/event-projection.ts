import { z } from "zod"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"

const Interest = z.object({
  scopeID: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  partID: z.string(),
  generation: z.number().int().nonnegative(),
})
export const ContentInterests = z.object({
  parts: Interest.array().max(4096),
  active: z
    .object({ scopeID: z.string(), sessionID: z.string(), generation: z.number().int().nonnegative() })
    .optional(),
})
type Interest = z.infer<typeof Interest>
type Payload = {
  type: string
  properties: { part?: MessageV2.Part; info?: MessageV2.Info; delta?: string }
  epoch?: string
  seq?: number
  streaming?: boolean
}
type Event = { scopeID: string | null; payload: Payload }
type Projected = {
  scopeID: string | null
  payload: {
    type: string
    epoch?: string
    seq?: number
    streaming?: boolean
    properties: {
      summary: MessageV2.PartSummary
      delta?: string
      subscription?: number
      content?: { kind: "checkpoint"; part: MessageV2.Part } | { kind: "delta"; delta: string; baseVersion: string }
      checkpointEpoch?: string
      checkpointSeq?: number
    }
  }
}
type Subscription = {
  interest: Interest
  ready: boolean
  reading?: boolean
  implicit?: boolean
  version?: string
  checkpoint: number
  latest?: Event
}
const identity = (item: Interest) => `${item.scopeID}\0${item.sessionID}\0${item.messageID}\0${item.partID}`

export function projectReplayEvent(
  input: unknown,
  summarizeMessage: (info: MessageV2.Info) => { info: MessageV2.Info; content: { version: string; bytes: number } },
): unknown {
  if (!input || typeof input !== "object" || !("type" in input) || !("properties" in input)) return input
  const payload = input as Payload
  if (payload.type === "message.part.updated" && payload.properties.part)
    return {
      ...payload,
      type: "message.part.summary",
      properties: { summary: MessageV2.summarizePart(payload.properties.part) },
    }
  if (payload.type === "message.updated" && payload.properties.info) {
    const header = summarizeMessage(payload.properties.info)
    return { ...payload, properties: { info: header.info, content: header.content } }
  }
  return input
}

export function createEventProjection(send: (event: Projected) => void) {
  const subscriptions = new Map<string, Subscription>()
  let active: z.infer<typeof ContentInterests>["active"]
  let disposed = false
  const project = (event: Event, prepared?: MessageV2.PartSummary): Projected => {
    const part = event.payload.properties.part!
    const summary = prepared ?? MessageV2.summarizePart(part)
    const key = identity({
      scopeID: event.scopeID!,
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
      generation: 0,
    })
    let subscription = subscriptions.get(key)
    if (
      !subscription &&
      active?.scopeID === event.scopeID &&
      active.sessionID === part.sessionID &&
      event.payload.streaming &&
      (part.type === "text" || part.type === "reasoning")
    ) {
      const implicit = [...subscriptions].filter(([, entry]) => entry.implicit)
      if (implicit.length >= 32) subscriptions.delete(implicit[0]![0])
      subscription = {
        interest: { ...active, messageID: part.messageID, partID: part.id },
        ready: true,
        implicit: true,
        checkpoint: 0,
      }
      subscriptions.set(key, subscription)
    }
    const properties: Projected["payload"]["properties"] = { summary }
    if (subscription) {
      properties.subscription = subscription.interest.generation
      if (!subscription.ready) subscription.latest = event
      else {
        const now = Date.now()
        if (
          event.payload.streaming &&
          event.payload.properties.delta !== undefined &&
          subscription.version &&
          now - subscription.checkpoint < 1000
        ) {
          properties.content = {
            kind: "delta",
            delta: event.payload.properties.delta,
            baseVersion: subscription.version,
          }
        } else {
          properties.content = { kind: "checkpoint", part }
          properties.delta = event.payload.properties.delta
          subscription.checkpoint = now
        }
        subscription.version = summary.content.version
      }
    }
    if (subscription?.implicit && !event.payload.streaming) subscriptions.delete(key)
    return { scopeID: event.scopeID, payload: { ...event.payload, type: "message.part.summary", properties } }
  }
  return {
    project,
    async interests(
      input: z.infer<typeof ContentInterests>,
      read: (interest: Interest) => Promise<{ part: MessageV2.Part; epoch: string; seq: number }>,
    ) {
      if (disposed) return
      active = input.active
      const wanted = new Map(input.parts.map((item) => [identity(item), item]))
      for (const [key, entry] of subscriptions) {
        const next = wanted.get(key)
        if (
          (next && entry.interest.generation !== next.generation) ||
          (!next &&
            !(
              active &&
              active.scopeID === entry.interest.scopeID &&
              active.sessionID === entry.interest.sessionID &&
              active.generation === entry.interest.generation
            ))
        )
          subscriptions.delete(key)
      }
      const pending = input.parts.filter((item) => {
        const entry = subscriptions.get(identity(item))
        return !entry || (!entry.ready && !entry.reading) || entry.implicit
      })
      for (const item of pending) subscriptions.set(identity(item), { interest: item, ready: false, checkpoint: 0 })
      for (let offset = 0; offset < pending.length; offset += 4)
        await Promise.all(
          pending.slice(offset, offset + 4).map(async (item) => {
            const key = identity(item)
            const entry = subscriptions.get(key)
            if (!entry || entry.interest.generation !== item.generation || entry.ready || entry.reading) return
            entry.reading = true
            try {
              const checkpoint = await read(item)
              if (disposed || subscriptions.get(key) !== entry) return
              const latest = entry.latest?.payload.properties.part ?? checkpoint.part
              entry.ready = true
              const frame = project({
                scopeID: item.scopeID,
                payload: { type: "message.part.updated", properties: { part: latest } },
              })
              frame.payload.properties.checkpointEpoch = checkpoint.epoch
              frame.payload.properties.checkpointSeq = checkpoint.seq
              send(frame)
            } catch {
              entry.reading = false
            }
          }),
        )
    },
    dispose() {
      disposed = true
      subscriptions.clear()
      active = undefined
    },
  }
}
