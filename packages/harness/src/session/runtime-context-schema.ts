import { z } from "zod"

export namespace RuntimeContextMetadata {
  export const Source = z.object({
    id: z.string(),
    kind: z.enum(["state", "knowledge", "event"]).default("state"),
    state: z.enum(["present", "cleared", "unavailable"]),
    revision: z.string(),
    range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional(),
    blockHash: z.string().optional(),
  })
  export const Schema = z.object({
    version: z.literal(2),
    scope: z.string(),
    role: z.literal("user"),
    contentHash: z.string(),
    sources: z.array(Source),
  })
  export type Info = z.infer<typeof Schema>

  export function parse(value: unknown): Info {
    if (value && typeof value === "object" && "version" in value && value.version === 1)
      return Schema.parse({ ...value, version: 2 })
    return Schema.parse(value)
  }

  export function hash(text: string): string {
    return new Bun.CryptoHasher("sha256").update(text).digest("hex")
  }

  export function verified(source: Info["sources"][number], text: string): boolean {
    const range = source.range
    return (
      !!range &&
      range.end <= text.length &&
      range.end > range.start &&
      hash(text.slice(range.start, range.end)) === source.blockHash
    )
  }
}
