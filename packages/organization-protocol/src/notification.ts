import { z } from "zod"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationIdentity as Identity } from "./identity.js"

export namespace OrganizationNotificationProtocol {
  export const Version = 1
  export const FrameLimit = 16_384
  export const PendingLimit = 65_536
  const StreamID = z.uuid()
  const Sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  export const Audience = z.strictObject({
    orgID: Identity.ID,
    accountID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    authRevision: Identity.Revision,
  })
  export type Audience = z.infer<typeof Audience>
  export const Observation = z
    .strictObject({
      noticeID: z.uuid(),
      kind: z.enum(["completion", "error"]),
      sessionID: Identity.ID,
      binding: Protocol.SessionBinding,
      occurredAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgNotificationObservation" })
  export type Observation = z.infer<typeof Observation>
  export const Ready = Audience.extend({ type: z.literal("ready"), streamID: StreamID, sequence: z.literal(0) })
  export const Frame = z
    .discriminatedUnion("type", [
      Ready,
      z.strictObject({ type: z.literal("notice"), streamID: StreamID, sequence: Sequence, notice: Observation }),
      z.strictObject({ type: z.literal("heartbeat"), streamID: StreamID, sequence: Sequence }),
    ])
    .meta({ ref: "OrgNotificationFrame" })
  export type Frame = z.infer<typeof Frame>

  export function encode(value: Frame) {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(Frame.parse(value))}\n\n`)
    if (bytes.byteLength > FrameLimit) throw new Error("Notification frame exceeds its bound")
    return bytes
  }

  export function read(stream: ReadableStream<Uint8Array>, expected: Audience, inputSignal?: AbortSignal) {
    const audience = Audience.parse(expected)
    const signal = inputSignal
    return (async function* (): AsyncGenerator<Frame> {
      signal?.throwIfAborted()
      const reader = stream.getReader()
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      signal?.addEventListener("abort", cancel, { once: true })
      const decoder = new TextDecoder("utf-8", { fatal: true })
      const encoder = new TextEncoder()
      let pending = ""
      let streamID: string | undefined
      let sequence = -1
      try {
        while (true) {
          signal?.throwIfAborted()
          const chunk = await reader.read()
          signal?.throwIfAborted()
          if (chunk.done) {
            pending += decoder.decode()
            if (pending || !streamID) throw new Error("Notification stream is incomplete")
            return
          }
          for (let offset = 0; offset < chunk.value.byteLength; offset += 1024) {
            pending += decoder.decode(chunk.value.subarray(offset, offset + 1024), { stream: true })
            let boundary: number
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              signal?.throwIfAborted()
              const event = pending.slice(0, boundary)
              pending = pending.slice(boundary + 2)
              if (
                encoder.encode(event).byteLength + 2 > FrameLimit ||
                !event.startsWith("data: ") ||
                event.includes("\n")
              )
                throw new Error("Invalid notification frame")
              let frame: Frame
              try {
                frame = Frame.parse(JSON.parse(event.slice(6)))
              } catch {
                throw new Error("Invalid notification frame")
              }
              if (!streamID) {
                if (
                  frame.type !== "ready" ||
                  Object.entries(audience).some(([key, value]) => Reflect.get(frame, key) !== value)
                )
                  throw new Error("Notification audience changed")
                streamID = frame.streamID
              } else if (frame.type === "ready" || frame.streamID !== streamID)
                throw new Error("Notification stream changed")
              if (frame.sequence !== ++sequence) throw new Error("Notification sequence is not contiguous")
              if (frame.type === "notice" && frame.notice.binding.orgID !== audience.orgID)
                throw new Error("Notification organization changed")
              yield frame
            }
            if (encoder.encode(pending).byteLength > FrameLimit) throw new Error("Notification frame exceeds its bound")
          }
        }
      } finally {
        signal?.removeEventListener("abort", cancel)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    })()
  }
}
