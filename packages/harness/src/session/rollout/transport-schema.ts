import { InputImages } from "./input-images"
import z from "zod"
import { RolloutTiming } from "./timing"

export namespace RolloutTransportSchema {
  export const CHUNK_BYTES = 256 * 1024
  const identity = { attemptID: z.uuid() }
  const channel = z.enum(["request", "response"])
  export const Event = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("attempt-start"),
        ...identity,
        url: z.string(),
        method: z.string(),
        mediaType: z.string(),
        inputImages: InputImages.List.optional(),
        timing: RolloutTiming.Info.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("attempt-sent"),
        ...identity,
        timing: RolloutTiming.Info,
        requestImages: InputImages.Hashes.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("response"),
        ...identity,
        status: z.number().int(),
        mediaType: z.string(),
        headers: z.record(z.string(), z.string()),
        timing: RolloutTiming.Info.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("chunk"),
        ...identity,
        channel,
        data: z.custom<Uint8Array>(
          (value) => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= CHUNK_BYTES,
          "Invalid rollout transport chunk",
        ),
        timing: RolloutTiming.Info.optional(),
      })
      .strict(),
    z.object({ type: z.literal("body-end"), ...identity, channel, complete: z.boolean() }).strict(),
    z
      .object({
        type: z.literal("attempt-end"),
        ...identity,
        status: z.enum(["completed", "failed", "cancelled"]),
        error: z.string().optional(),
        timing: RolloutTiming.Info.optional(),
      })
      .strict(),
  ])
  export type Event = z.infer<typeof Event>
  export type Sink = (event: Event) => Promise<void>
}
