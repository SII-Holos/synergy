import { z } from "zod"
import { createHash } from "node:crypto"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { createProjectionContent } from "./projection-content"
import { ContentInterests } from "./event-projection"
import { createProjectionCursors } from "./projection-cursors"

export const VIEW_FRAME_LIMIT = 64 * 1024
export const ViewInterest = z.object({
  kind: z.string().max(80),
  scopeID: z.string(),
  sessionID: z.string(),
  generation: z.number().int().nonnegative(),
  runID: z.string().optional(),
  nodeIDs: z.array(z.string()).max(100).optional(),
})
export const ViewInterests = ContentInterests.extend({
  generation: z.number().int().nonnegative(),
  details: ViewInterest.array().max(32),
})
export type ViewInterest = z.infer<typeof ViewInterest>
export type ViewEvent = {
  scopeID: string | null
  payload: { type: string; properties: Record<string, unknown>; epoch?: string; seq?: number; streaming?: boolean }
}
export type ViewProjectionContribution = {
  kind: string
  eventType: string
  legacy?(): () => void
  open(
    interest: ViewInterest,
    send: (event: ViewEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ project(event: ViewEvent): void; dispose(): void }>
}
const omitted = (type: string) =>
  type === "execution.updated" ||
  type === "rollout.updated" ||
  type === "lsp.client.diagnostics" ||
  type.startsWith("usage.")
export function viewCursor(event: ViewEvent): ViewEvent | null {
  const { epoch, seq } = event.payload
  return epoch !== undefined && seq !== undefined
    ? {
        scopeID: event.scopeID,
        payload: {
          type: "server.cursor",
          epoch,
          seq,
          properties: { epoch, fromSeq: seq, toSeq: seq },
        },
      }
    : null
}
function bounded(event: ViewEvent): ViewEvent {
  if (Buffer.byteLength(JSON.stringify(event)) <= VIEW_FRAME_LIMIT) return event
  return {
    ...event,
    payload: { ...event.payload, type: "server.projection.reset", properties: { eventType: event.payload.type } },
  }
}
export function projectViewReplay(events: ViewEvent["payload"][], contributions: ViewProjectionContribution[] = []) {
  const result: ViewEvent["payload"][] = []
  const cursors = createProjectionCursors(
    (event) => result.push(event.payload),
    () => () => {},
  )
  for (const payload of events) {
    if (omitted(payload.type) || contributions.some((item) => item.eventType === payload.type)) {
      const cursor = viewCursor({ scopeID: null, payload })
      if (cursor) cursors.project(cursor)
      continue
    }
    const projected =
      payload.type === "message.part.updated"
        ? {
            ...payload,
            type: "message.part.summary",
            properties: {
              summary: payload.properties.summary ?? MessageV2.summarizePart(payload.properties.part as MessageV2.Part),
            },
          }
        : payload.type === "message.updated"
          ? { ...payload, properties: SessionHistory.summarizeMessage(payload.properties.info as MessageV2.Info) }
          : payload
    const frame = cursors.project(bounded({ scopeID: null, payload: projected }))
    if (frame) result.push(frame.payload)
  }
  cursors.flush()
  return result
}
type PartInterest = z.infer<typeof ContentInterests>["parts"][number]
type Stream = {
  id: string
  revision: number
  offset: number
  summary: MessageV2.PartSummary
  hash: ReturnType<typeof createHash>
}
// UTF-16 hashing preserves append boundaries that split a surrogate pair.
const textHash = (text: string) => createHash("sha256").update(text, "utf16le")
type Subscription = {
  interest: PartInterest
  stream?: Stream
  ready: boolean
  latest?: ViewEvent
  checkpoint?: { token: string; release(): void }
}
const identity = (part: Omit<PartInterest, "generation">) =>
  JSON.stringify([part.scopeID, part.sessionID, part.messageID, part.partID])

export function createViewProjection(
  output: (event: ViewEvent) => void,
  contributions: ViewProjectionContribution[] = [],
  contentCheckpoints = createProjectionContent(),
) {
  const cursors = createProjectionCursors(output)
  const send = (event: ViewEvent) => {
    const frame = cursors.project(event)
    if (frame) output(frame)
  }
  const parts = new Map<string, Subscription>()
  const details = new Map<
    string,
    {
      interest: ViewInterest
      controller: AbortController
      pending: ViewEvent[]
      value?: Awaited<ReturnType<ViewProjectionContribution["open"]>>
    }
  >()
  let active: z.infer<typeof ContentInterests>["active"]
  let generation = -1,
    disposed = false
  const projectPart = (event: ViewEvent): ViewEvent | null => {
    const part = event.payload.properties.part as MessageV2.Part
    const key = identity({
      scopeID: event.scopeID!,
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
    })
    let subscription = parts.get(key)
    if (
      !subscription &&
      active?.scopeID === event.scopeID &&
      active.sessionID === part.sessionID &&
      event.payload.streaming &&
      (part.type === "text" || part.type === "reasoning")
    ) {
      subscription = { interest: { ...active, messageID: part.messageID, partID: part.id }, ready: true }
      parts.set(key, subscription)
    }
    const delta = event.payload.properties.delta
    const observed = event.payload.properties.summary as MessageV2.PartSummary | undefined
    const stream = subscription?.stream
    const append =
      event.payload.streaming && typeof delta === "string" && (part.type === "text" || part.type === "reasoning")
    if (append && !subscription) return viewCursor(event)
    if (subscription && !subscription.ready) {
      subscription.latest = event
      return viewCursor(event)
    }
    let summary: MessageV2.PartSummary
    let content: unknown
    let resumed = false
    if (
      append &&
      stream &&
      subscription?.ready &&
      part.text.length === stream.offset + delta.length &&
      part.text.endsWith(delta)
    ) {
      stream.revision++
      summary = {
        ...stream.summary,
        preview: part.text.slice(0, 256),
        render: observed?.render ?? true,
        reasoningKey: observed?.reasoningKey ?? stream.summary.reasoningKey,
        content: {
          version: `stream:${stream.id}:${stream.revision}`,
          bytes: observed?.content.bytes ?? stream.summary.content.bytes + Buffer.byteLength(delta),
        },
      }
      content = { kind: "append", streamID: stream.id, revision: stream.revision, offset: stream.offset, delta }
      stream.offset = part.text.length
      stream.summary = summary
      stream.hash.update(delta, "utf16le")
    } else {
      summary = observed ?? MessageV2.summarizePart(part)
      if (subscription?.ready) {
        if (part.type === "text" || part.type === "reasoning") {
          const hash = textHash(part.text)
          if (
            !append &&
            stream &&
            stream.offset === part.text.length &&
            stream.hash.copy().digest("hex") === hash.copy().digest("hex")
          ) {
            stream.summary = summary
            content = {
              kind: "anchor",
              streamID: stream.id,
              revision: ++stream.revision,
              offset: stream.offset,
              part: { ...part, text: undefined },
            }
          } else subscription.stream = { id: crypto.randomUUID(), revision: 0, offset: part.text.length, summary, hash }
        } else subscription.stream = undefined
        if (content === undefined) {
          if (!event.payload.streaming && subscription.interest.version === summary.content.version) resumed = true
          else if (summary.content.bytes < VIEW_FRAME_LIMIT - 4096) content = { kind: "checkpoint", part }
          else {
            subscription.checkpoint?.release()
            subscription.checkpoint = contentCheckpoints.retain(subscription.interest, part, summary.content)
            content = { kind: "reference", checkpoint: subscription.checkpoint.token }
          }
        }
      } else if (subscription) subscription.latest = event
    }
    if (parts.size > 4096) {
      const key = parts.keys().next().value!
      parts.get(key)?.checkpoint?.release()
      parts.delete(key)
    }
    const properties: Record<string, unknown> = {
      summary,
      ...(subscription && { subscription: subscription.interest.generation }),
      ...(content !== undefined && { content }),
      ...(subscription?.stream &&
        (content !== undefined || resumed) && {
          stream: {
            id: subscription.stream.id,
            revision: subscription.stream.revision,
            offset: subscription.stream.offset,
          },
        }),
    }
    const frame = { scopeID: event.scopeID, payload: { ...event.payload, type: "message.part.summary", properties } }
    if (Buffer.byteLength(JSON.stringify(frame)) > VIEW_FRAME_LIMIT) {
      if (subscription) {
        subscription.checkpoint?.release()
        subscription.checkpoint = contentCheckpoints.retain(subscription.interest, part, summary.content)
        properties.content = { kind: "reference", checkpoint: subscription.checkpoint.token }
      }
    }
    return bounded(frame)
  }
  const project = (event: ViewEvent): ViewEvent | null => {
    for (const [key, detail] of details) {
      if (detail.value) detail.value.project(event)
      else if (
        event.scopeID === detail.interest.scopeID &&
        event.payload.properties.sessionID === detail.interest.sessionID &&
        contributions.some((item) => item.kind === detail.interest.kind && item.eventType === event.payload.type)
      ) {
        if (detail.pending.length < 64) detail.pending.push(event)
        else {
          detail.controller.abort()
          details.delete(key)
          send({
            scopeID: detail.interest.scopeID,
            payload: {
              type: "server.view.patch",
              properties: {
                kind: detail.interest.kind,
                sessionID: detail.interest.sessionID,
                generation: detail.interest.generation,
                revision: 0,
                previousRevision: 0,
                patches: [],
              },
            },
          })
        }
      }
    }
    if (
      omitted(event.payload.type) ||
      contributions.some((contribution) => contribution.eventType === event.payload.type)
    )
      return viewCursor(event)
    if (event.payload.type === "message.part.updated") return projectPart(event)
    if (event.payload.type === "message.updated")
      return bounded({
        ...event,
        payload: {
          ...event.payload,
          properties: SessionHistory.summarizeMessage(event.payload.properties.info as MessageV2.Info),
        },
      })
    return bounded(event)
  }
  return {
    project(event: ViewEvent) {
      if (disposed) return null
      const frame = project(event)
      return frame ? cursors.project(frame) : null
    },
    async interests(
      input: z.infer<typeof ViewInterests>,
      read: (interest: PartInterest) => Promise<{ part: MessageV2.Part; epoch: string; seq: number }>,
    ) {
      if (disposed || input.generation < generation) return
      generation = input.generation
      active = input.active
      const requested = new Map(
        input.details.map((interest) => [
          JSON.stringify([interest.kind, interest.scopeID, interest.sessionID]),
          interest,
        ]),
      )
      for (const [key, detail] of details)
        if (JSON.stringify(detail.interest) !== JSON.stringify(requested.get(key))) {
          detail.controller.abort()
          detail.value?.dispose()
          details.delete(key)
        }
      const openingDetails = Promise.all(
        [...requested].map(async ([key, interest]) => {
          if (details.has(key)) return
          const contribution = contributions.find((value) => value.kind === interest.kind)
          if (!contribution) return
          const entry: {
            interest: ViewInterest
            controller: AbortController
            pending: ViewEvent[]
            value?: Awaited<ReturnType<ViewProjectionContribution["open"]>>
          } = { interest, controller: new AbortController(), pending: [] }
          details.set(key, entry)
          try {
            const value = await contribution.open(
              interest,
              (event) => {
                if (!disposed && !entry.controller.signal.aborted && details.get(key) === entry) send(bounded(event))
              },
              entry.controller.signal,
            )
            if (disposed || entry.controller.signal.aborted || details.get(key) !== entry) {
              value.dispose()
              return
            }
            entry.value = value
            for (const event of entry.pending) value.project(event)
            entry.pending = []
          } catch {
            if (details.get(key) === entry) details.delete(key)
          }
        }),
      )
      const wanted = new Map(input.parts.map((interest) => [identity(interest), interest]))
      for (const [key, value] of parts) {
        const next = wanted.get(key)
        if (
          next
            ? next.generation !== value.interest.generation
            : !(
                active?.scopeID === value.interest.scopeID &&
                active.sessionID === value.interest.sessionID &&
                active.generation === value.interest.generation
              )
        ) {
          value.checkpoint?.release()
          parts.delete(key)
        }
      }
      const pending = input.parts.filter((interest) => !parts.has(identity(interest)))
      for (const interest of pending) parts.set(identity(interest), { interest, ready: false })
      for (let offset = 0; offset < pending.length; offset += 4)
        await Promise.all(
          pending.slice(offset, offset + 4).map(async (interest) => {
            const key = identity(interest),
              entry = parts.get(key)
            if (!entry || entry.interest.generation !== interest.generation) return
            try {
              const checkpoint = await read(interest)
              if (disposed || parts.get(key) !== entry) return
              entry.ready = true
              const frame = projectPart(
                entry.latest ?? {
                  scopeID: interest.scopeID,
                  payload: { type: "message.part.updated", properties: { part: checkpoint.part } },
                },
              )
              if (!frame) return
              delete frame.payload.seq
              delete frame.payload.epoch
              Object.assign(frame.payload.properties, {
                checkpointEpoch: checkpoint.epoch,
                checkpointSeq: checkpoint.seq,
              })
              send(frame)
            } catch {
              if (parts.get(key) === entry) parts.delete(key)
            }
          }),
        )
      if (disposed || input.generation !== generation) return
      await openingDetails
    },
    dispose() {
      disposed = true
      cursors.dispose()
      for (const detail of details.values()) {
        detail.controller.abort()
        detail.value?.dispose()
      }
      details.clear()
      for (const entry of parts.values()) entry.checkpoint?.release()
      parts.clear()
      active = undefined
    },
  }
}
