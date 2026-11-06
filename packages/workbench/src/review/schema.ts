import { z } from "zod"
import { SnapshotSchema } from "@ericsanchezok/synergy-harness/session/snapshot-schema"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export namespace ReviewSchema {
  export const Invalid = NamedError.create("ReviewInvalid", z.object({ message: z.string() }))
  export const Conflict = NamedError.create("ReviewConflict", z.object({ message: z.string() }))
  export const CompareInput = z.object({
    source: z.enum(["worktree", "branch"]),
    workspaceID: z.string().min(1),
    generation: z.coerce.number().int().positive(),
    from: z.string().min(1).max(200).optional(),
    to: z.string().min(1).max(200).optional(),
  })
  export type CompareInput = z.infer<typeof CompareInput>
  export const File = SnapshotSchema.FileDiff.extend({
    version: z.string(),
    status: z.enum(["modified", "added", "deleted"]),
  }).meta({ ref: "ReviewComparisonFile" })
  export type File = z.infer<typeof File>
  export const Comparison = z
    .object({
      source: z.enum(["worktree", "branch"]),
      from: z.string(),
      to: z.string(),
      files: z.array(File).max(5000),
    })
    .meta({ ref: "ReviewComparison" })
  export const FileInput = CompareInput.extend({ file: SnapshotSchema.FilePath, version: z.string().min(1) })
  export const Content = SnapshotSchema.FileVersions.extend({
    diff: SnapshotSchema.FileDiff,
    version: z.string(),
  }).meta({ ref: "ReviewFileContent" })
}
