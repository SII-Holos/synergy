import { z } from "zod"
import { JsonValue } from "./json-value"

/** Portable render protocol shared by the Media owner and its untrusted UI runtime. */
export namespace RenderArtifact {
  export const MIME = "application/vnd.synergy.visual+json"
  export const SOURCE_BYTES = 1024 * 1024
  export const STATE_BYTES = 16 * 1024
  export const Library = z.enum(["d3", "chart", "mermaid"])
  export const ID = z.string().uuid()
  export const Source = z
    .object({
      format: z.literal("synergy.visual"),
      version: z.literal(1),
      id: ID,
      mode: z.enum(["static", "interactive"]),
      title: z.string().min(1).max(160),
      layout: z.enum(["normal", "wide"]),
      libraries: z.array(Library).max(3),
      html: z
        .string()
        .min(1)
        .refine((text) => new TextEncoder().encode(text).byteLength <= SOURCE_BYTES, "HTML exceeds 1 MiB"),
      replaces: ID.optional(),
    })
    .strict()
    .meta({ ref: "RenderSource" })
  export type Source = z.infer<typeof Source>
  export const Descriptor = Source.omit({ html: true })
    .extend({
      source: z.string().regex(/^asset:\/\/[a-f0-9]{16}\.bin$/),
    })
    .strict()
    .meta({ ref: "RenderDescriptor" })
  export type Descriptor = z.infer<typeof Descriptor>
  export const Content = z
    .object({
      modelContent: JsonValue.optional(),
      uiContent: JsonValue.optional(),
    })
    .strict()
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= STATE_BYTES,
      "State exceeds 16 KiB",
    )
    .meta({ ref: "RenderContent" })
  export type Content = z.infer<typeof Content>
  export const State = z
    .object({
      revision: z.number().int().nonnegative(),
      updatedAt: z.number().nonnegative(),
      mutationID: z.string().max(100).optional(),
      content: Content,
    })
    .strict()
    .meta({ ref: "RenderState" })
  export type State = z.infer<typeof State>
  export const Write = z
    .object({
      revision: z.number().int().nonnegative(),
      mutationID: z.string().min(1).max(100),
      content: Content,
    })
    .strict()
    .meta({ ref: "RenderStateWrite" })
  export type Write = z.infer<typeof Write>
  export const Target = z
    .object({
      sessionID: z.string().regex(/^ses_[\w]+$/),
      messageID: z.string().regex(/^msg_[\w]+$/),
      partID: z.string().regex(/^prt_[\w]+$/),
    })
    .strict()
    .meta({ ref: "RenderTarget" })
  export type Target = z.infer<typeof Target>
  export const Snapshot = z
    .object({ descriptor: Descriptor, source: Source, state: State })
    .meta({ ref: "RenderSnapshot" })
  export const FollowUp = z
    .object({
      requestID: z.string().min(1).max(100),
      text: z.string().trim().min(1).max(8000),
    })
    .strict()
  export type FollowUp = z.infer<typeof FollowUp>
  export function emptyState(): State {
    return { revision: 0, updatedAt: 0, content: {} }
  }
  export function descriptor(metadata: unknown): Descriptor | undefined {
    if (!metadata || typeof metadata !== "object" || !("visual" in metadata)) return
    const result = Descriptor.safeParse(metadata.visual)
    return result.success ? result.data : undefined
  }
  export function state(metadata: unknown): State {
    if (!metadata || typeof metadata !== "object" || !("visualState" in metadata)) return emptyState()
    const result = State.safeParse(metadata.visualState)
    return result.success ? result.data : emptyState()
  }
}
