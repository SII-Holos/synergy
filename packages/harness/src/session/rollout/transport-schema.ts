import z from "zod"

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
      })
      .strict(),
    z
      .object({
        type: z.literal("response"),
        ...identity,
        status: z.number().int(),
        mediaType: z.string(),
        headers: z.record(z.string(), z.string()),
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
      })
      .strict(),
    z.object({ type: z.literal("body-end"), ...identity, channel, complete: z.boolean() }).strict(),
    z
      .object({
        type: z.literal("attempt-end"),
        ...identity,
        status: z.enum(["completed", "failed", "cancelled"]),
        error: z.string().optional(),
      })
      .strict(),
  ])
  export type Event = z.infer<typeof Event>
  export type Sink = (event: Event) => Promise<void>
}
