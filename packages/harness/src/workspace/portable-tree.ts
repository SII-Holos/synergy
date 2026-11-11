import { z } from "zod"
import { SessionTransferStream as Stream } from "../session/transfer-stream"
import { WorkspaceTree } from "./tree"

export namespace WorkspacePortableTree {
  const Mode = z.number().int().min(0).max(0o777)
  export const Metadata = z.discriminatedUnion("kind", [
    z.strictObject({ version: z.literal(1), kind: z.literal("file"), mode: Mode }),
    z.strictObject({ version: z.literal(1), kind: z.literal("directory"), mode: Mode }),
    z.strictObject({
      version: z.literal(1),
      kind: z.literal("symlink"),
      mode: Mode,
      target: z.string().min(1).max(4096),
    }),
  ])
  export type Metadata = z.infer<typeof Metadata>
  export const Root = z
    .strictObject({ version: z.literal(1), mode: Mode, tree: Stream.Root })
    .refine(
      (value) => Object.keys(value.tree.owners).length === 1 && value.tree.owners["workspace-files"] === 1,
      "Portable Workspace files require their own versioned owner",
    )
  export type Root = z.infer<typeof Root>
  export function path(value: string, metadata: Metadata) {
    WorkspaceTree.Path.parse(value)
    if (metadata.kind === "symlink")
      WorkspaceTree.Manifest.parse({
        version: 1,
        entries: [
          ...value
            .split("/")
            .slice(0, -1)
            .map((_part, index, parts) => ({
              kind: "directory" as const,
              path: parts.slice(0, index + 1).join("/"),
              mode: 0o755,
            })),
          { path: value, ...metadata },
        ],
      })
    return value
  }
}
