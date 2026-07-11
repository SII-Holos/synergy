import z from "zod"

export namespace WorkspaceFile {
  export const NodeType = z.enum(["file", "directory", "symlink", "unknown"])
  export type NodeType = z.infer<typeof NodeType>

  export const GitStatus = z.enum(["added", "deleted", "modified", "renamed", "untracked"])
  export type GitStatus = z.infer<typeof GitStatus>

  export const Node = z
    .object({
      path: z.string(),
      name: z.string(),
      type: NodeType,
      size: z.number().int().nonnegative(),
      mtime: z.number().int().nonnegative(),
      ctime: z.number().int().nonnegative(),
      ignored: z.boolean(),
      hidden: z.boolean(),
      readonly: z.boolean(),
      symlink: z.boolean(),
      binary: z.boolean(),
      gitStatus: GitStatus.optional(),
    })
    .meta({ ref: "WorkspaceFileNode" })
  export type Node = z.infer<typeof Node>

  export const CursorPage = z
    .object({
      nextCursor: z.string().optional(),
      truncated: z.boolean(),
    })
    .meta({ ref: "WorkspaceCursorPage" })
  export type CursorPage = z.infer<typeof CursorPage>

  export const ChildrenResponse = z
    .object({
      path: z.string(),
      parent: Node.optional(),
      children: z.array(Node),
      nextCursor: z.string().optional(),
      truncated: z.boolean(),
    })
    .meta({ ref: "WorkspaceFileChildrenResponse" })
  export type ChildrenResponse = z.infer<typeof ChildrenResponse>

  export const TextRange = z
    .object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().nonnegative(),
    })
    .meta({ ref: "WorkspaceFileTextRange" })
  export type TextRange = z.infer<typeof TextRange>

  export const ReadText = z
    .object({
      kind: z.literal("text"),
      path: z.string(),
      node: Node,
      content: z.string(),
      mimeType: z.string().optional(),
      encoding: z.literal("utf-8"),
      range: TextRange,
      totalBytes: z.number().int().nonnegative(),
      lineCount: z.number().int().nonnegative().optional(),
      truncated: z.boolean(),
      truncationReason: z.enum(["size", "range"]).optional(),
      nextRange: TextRange.optional(),
    })
    .meta({ ref: "WorkspaceFileReadText" })

  export const ReadImage = z
    .object({
      kind: z.literal("image"),
      path: z.string(),
      node: Node,
      content: z.string(),
      mimeType: z.string(),
      encoding: z.literal("base64"),
      totalBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .meta({ ref: "WorkspaceFileReadImage" })

  export const ReadBinary = z
    .object({
      kind: z.literal("binary"),
      path: z.string(),
      node: Node,
      mimeType: z.string().optional(),
      totalBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
      unsupportedReason: z.string(),
    })
    .meta({ ref: "WorkspaceFileReadBinary" })

  export const ReadResult = z.discriminatedUnion("kind", [ReadText, ReadImage, ReadBinary]).meta({
    ref: "WorkspaceFileReadResult",
  })
  export type ReadResult = z.infer<typeof ReadResult>

  export const FileSearchItem = z
    .object({
      kind: z.literal("file"),
      path: z.string(),
      name: z.string(),
      type: z.enum(["file", "directory"]),
      score: z.number(),
      indices: z.array(z.number().int().nonnegative()),
      node: Node.optional(),
    })
    .meta({ ref: "WorkspaceFileSearchItem" })
  export type FileSearchItem = z.infer<typeof FileSearchItem>

  export const ContentSearchItem = z
    .object({
      kind: z.literal("content"),
      path: z.string(),
      lineNumber: z.number().int().positive(),
      column: z.number().int().nonnegative(),
      line: z.string(),
      score: z.number(),
      submatches: z.array(
        z.object({
          text: z.string(),
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
        }),
      ),
      previewRanges: z.array(
        z.object({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
        }),
      ),
    })
    .meta({ ref: "WorkspaceContentSearchItem" })
  export type ContentSearchItem = z.infer<typeof ContentSearchItem>

  export const SymbolSearchItem = z
    .object({
      kind: z.literal("symbol"),
      name: z.string(),
      symbolKind: z.number(),
      path: z.string(),
      range: z.object({
        start: z.object({
          line: z.number(),
          character: z.number(),
        }),
        end: z.object({
          line: z.number(),
          character: z.number(),
        }),
      }),
      score: z.number(),
    })
    .meta({ ref: "WorkspaceSymbolSearchItem" })
  export type SymbolSearchItem = z.infer<typeof SymbolSearchItem>

  export const SearchCapability = z
    .object({
      available: z.boolean(),
      reason: z.string().optional(),
    })
    .meta({ ref: "WorkspaceSearchCapability" })
  export type SearchCapability = z.infer<typeof SearchCapability>

  export const SearchResponse = z
    .object({
      kind: z.enum(["files", "content", "symbol"]),
      query: z.string(),
      items: z.array(z.union([FileSearchItem, ContentSearchItem, SymbolSearchItem])),
      nextCursor: z.string().optional(),
      truncated: z.boolean(),
      capability: SearchCapability.optional(),
    })
    .meta({ ref: "WorkspaceFileSearchResponse" })
  export type SearchResponse = z.infer<typeof SearchResponse>

  export const WriteConflictPolicy = z.enum(["fail", "overwrite"])
  export type WriteConflictPolicy = z.infer<typeof WriteConflictPolicy>

  export const WriteFileInput = z
    .object({
      path: z.string(),
      content: z.string(),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      createParents: z.boolean().default(false),
      conflictPolicy: WriteConflictPolicy.default("fail"),
      expectedMtime: z.number().int().nonnegative().optional(),
    })
    .meta({ ref: "WorkspaceFileWriteFileInput" })
  export type WriteFileInput = z.infer<typeof WriteFileInput>

  export const CreateDirectoryInput = z
    .object({
      path: z.string(),
      createParents: z.boolean().default(true),
    })
    .meta({ ref: "WorkspaceFileCreateDirectoryInput" })
  export type CreateDirectoryInput = z.infer<typeof CreateDirectoryInput>

  export const MoveInput = z
    .object({
      from: z.string(),
      to: z.string(),
      conflictPolicy: WriteConflictPolicy.default("fail"),
    })
    .meta({ ref: "WorkspaceFileMoveInput" })
  export type MoveInput = z.infer<typeof MoveInput>

  export const CopyInput = z
    .object({
      from: z.string(),
      to: z.string(),
      conflictPolicy: WriteConflictPolicy.default("fail"),
    })
    .meta({ ref: "WorkspaceFileCopyInput" })
  export type CopyInput = z.infer<typeof CopyInput>

  export const DeleteInput = z
    .object({
      path: z.string(),
      recursive: z.boolean().default(false),
      trash: z.boolean().default(true),
    })
    .meta({ ref: "WorkspaceFileDeleteInput" })
  export type DeleteInput = z.infer<typeof DeleteInput>

  export const StatusSummary = z
    .object({
      files: z.array(
        z.object({
          path: z.string(),
          status: GitStatus,
          added: z.number().int().nonnegative().optional(),
          removed: z.number().int().nonnegative().optional(),
        }),
      ),
    })
    .meta({ ref: "WorkspaceFileStatusSummary" })
  export type StatusSummary = z.infer<typeof StatusSummary>
}
