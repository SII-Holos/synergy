import z from "zod"
import { SessionBounds } from "./bounds"

export namespace SnapshotSchema {
  export const FileDiff = z
    .object({
      file: z.string(),
      additions: z.number(),
      deletions: z.number(),
      binary: z.boolean().optional(),
      preview: z.string().optional(),
      beforeBytes: z.number().int().nonnegative().optional(),
      afterBytes: z.number().int().nonnegative().optional(),
      truncated: z.boolean().optional(),
    })
    .strict()
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>

  export function fromContents(input: {
    file: string
    before: string
    after: string
    additions: number
    deletions: number
    preview?: string
  }): FileDiff {
    const beforeBytes = SessionBounds.byteLength(input.before)
    const afterBytes = SessionBounds.byteLength(input.after)
    const preview = SessionBounds.diffPreview(input.preview ?? simplePreview(input.before, input.after))
    return {
      file: input.file,
      additions: input.additions,
      deletions: input.deletions,
      ...preview,
      beforeBytes,
      afterBytes,
    }
  }

  export function fromPatch(input: {
    file: string
    additions: number
    deletions: number
    binary?: boolean
    patch?: string
    beforeBytes?: number
    afterBytes?: number
  }): FileDiff {
    return {
      file: input.file,
      additions: input.additions,
      deletions: input.deletions,
      ...(input.binary ? { binary: true } : {}),
      ...SessionBounds.diffPreview(input.patch ?? ""),
      ...(typeof input.beforeBytes === "number" ? { beforeBytes: input.beforeBytes } : {}),
      ...(typeof input.afterBytes === "number" ? { afterBytes: input.afterBytes } : {}),
    }
  }

  export function normalize(value: unknown): FileDiff | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const file = typeof record.file === "string" ? record.file : undefined
    if (!file) return undefined
    const additions = typeof record.additions === "number" ? record.additions : 0
    const deletions = typeof record.deletions === "number" ? record.deletions : 0
    const before = typeof record.before === "string" ? record.before : undefined
    const after = typeof record.after === "string" ? record.after : undefined
    if (before !== undefined || after !== undefined) {
      return fromContents({
        file,
        before: before ?? "",
        after: after ?? "",
        additions,
        deletions,
      })
    }
    return {
      file,
      additions,
      deletions,
      ...(record.binary === true ? { binary: true } : {}),
      ...(typeof record.preview === "string" ? SessionBounds.diffPreview(record.preview) : {}),
      ...(typeof record.beforeBytes === "number" ? { beforeBytes: record.beforeBytes } : {}),
      ...(typeof record.afterBytes === "number" ? { afterBytes: record.afterBytes } : {}),
      ...(record.truncated === true ? { truncated: true } : {}),
    }
  }

  export function normalizeArray(value: unknown): FileDiff[] | undefined {
    if (!Array.isArray(value)) return undefined
    const result = value.map(normalize).filter((item): item is FileDiff => item !== undefined)
    return result.length > 0 ? result : []
  }

  function simplePreview(before: string, after: string): string {
    if (!before && !after) return ""
    return `--- before\n${before}\n+++ after\n${after}`
  }
}
