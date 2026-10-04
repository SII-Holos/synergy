import { z } from "zod"
import { SessionBounds } from "./bounds"

export namespace SnapshotSchema {
  export const FilePath = z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        !value.includes("\\") &&
        !value.includes("\0") &&
        !value.startsWith("/") &&
        !/^[a-zA-Z]:/.test(value) &&
        !value.split("/").some((part) => !part || part === "." || part === ".."),
      "Expected a relative captured file path",
    )
  export const FileVersion = z
    .object({
      kind: z.enum(["text", "binary", "missing", "oversized", "symlink"]),
      version: z.string(),
      bytes: z.number().int().nonnegative(),
      content: z.string().optional(),
      base64: z.string().optional(),
    })
    .meta({ ref: "ReviewFileVersion" })
  export type FileVersion = z.infer<typeof FileVersion>
  export const FileVersions = z
    .object({
      before: FileVersion,
      after: FileVersion,
    })
    .meta({ ref: "ReviewFileVersions" })
  export type FileVersions = z.infer<typeof FileVersions>
  export const DiffState = z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending"), deadlineAt: z.number() }),
    z.object({ status: z.literal("ready") }),
    z.object({ status: z.literal("partial"), code: z.enum(["timeout", "git_failure", "incomplete", "unknown"]) }),
    z.object({ status: z.literal("error"), code: z.enum(["timeout", "git_failure", "incomplete", "unknown"]) }),
  ])
  export const Workspace = z
    .object({
      id: z.string().min(1),
      generation: z.number().int().positive(),
      root: z.string(),
      pathKind: z.literal("workspace").optional(),
    })
    .refine((source) => (source.pathKind === "workspace" ? source.root === "" : source.root.length > 0), {
      message: "A native snapshot needs a root; Workspace paths are relative",
    })
    .meta({ ref: "SnapshotWorkspace" })
  export type Workspace = z.infer<typeof Workspace>
  export const Omission = z.object({ file: z.string(), reason: z.enum(["size_limit", "read_failed"]) })
  export type Omission = z.infer<typeof Omission>
  export const Issue = z.object({
    workspace: Workspace.optional(),
    file: z.string().optional(),
    code: z.enum([
      "baseline_unavailable",
      "capture_failed",
      "interrupted",
      "legacy_range",
      "comparison_failed",
      "size_limit",
      "read_failed",
    ]),
  })

  export const FileDiff = z
    .object({
      file: z.string(),
      operationID: z.string().optional(),
      workspace: Workspace.optional(),
      legacyRoot: z.string().optional(),
      additions: z.number(),
      deletions: z.number(),
      binary: z.boolean().optional(),
      preview: z.string().optional(),
      patch: z.string().optional(),
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
    workspace?: Workspace
    legacyRoot?: string
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
      ...(input.workspace ? { workspace: input.workspace } : input.legacyRoot ? { legacyRoot: input.legacyRoot } : {}),
      additions: input.additions,
      deletions: input.deletions,
      ...preview,
      beforeBytes,
      afterBytes,
    }
  }

  export function fromPatch(input: {
    file: string
    workspace?: Workspace
    legacyRoot?: string
    additions: number
    deletions: number
    binary?: boolean
    patch?: string
    beforeBytes?: number
    afterBytes?: number
  }): FileDiff {
    return {
      file: input.file,
      ...(input.workspace ? { workspace: input.workspace } : input.legacyRoot ? { legacyRoot: input.legacyRoot } : {}),
      additions: input.additions,
      deletions: input.deletions,
      ...(input.binary ? { binary: true } : {}),
      ...(input.patch ? { patch: input.patch } : {}),
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
    const workspace = Workspace.safeParse(record.workspace)
    const attribution = workspace.success
      ? { workspace: workspace.data }
      : typeof record.legacyRoot === "string"
        ? { legacyRoot: record.legacyRoot }
        : {}
    const additions = typeof record.additions === "number" ? record.additions : 0
    const deletions = typeof record.deletions === "number" ? record.deletions : 0
    const before = typeof record.before === "string" ? record.before : undefined
    const after = typeof record.after === "string" ? record.after : undefined
    if (before !== undefined || after !== undefined) {
      return {
        ...fromContents({
          file,
          ...attribution,
          before: before ?? "",
          after: after ?? "",
          additions,
          deletions,
        }),
        ...(typeof record.operationID === "string" ? { operationID: record.operationID } : {}),
      }
    }
    return {
      file,
      ...(typeof record.operationID === "string" ? { operationID: record.operationID } : {}),
      ...attribution,
      additions,
      deletions,
      ...(record.binary === true ? { binary: true } : {}),
      ...(typeof record.patch === "string" && record.patch.length > 0 ? { patch: record.patch } : {}),
      ...(typeof record.preview === "string" ? SessionBounds.diffPreview(record.preview) : {}),
      ...(typeof record.beforeBytes === "number" ? { beforeBytes: record.beforeBytes } : {}),
      ...(typeof record.afterBytes === "number" ? { afterBytes: record.afterBytes } : {}),
      ...(record.truncated === true ? { truncated: true } : {}),
    }
  }

  export function boundArray(diffs: readonly FileDiff[]): FileDiff[] {
    return SessionBounds.diffAggregate(diffs)
  }

  export function normalizeArray(value: unknown): FileDiff[] | undefined {
    if (!Array.isArray(value)) return undefined
    const result = value.map(normalize).filter((item): item is FileDiff => item !== undefined)
    return boundArray(result)
  }

  function simplePreview(before: string, after: string): string {
    if (!before && !after) return ""
    return `--- before\n${before}\n+++ after\n${after}`
  }
}
