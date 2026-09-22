import path from "node:path"
import { z } from "zod"
import { SnapshotSchema } from "./snapshot-schema"
import type { MessageV2 } from "./message-v2"

export namespace SnapshotRanges {
  export const Range = z.object({
    workspace: SnapshotSchema.Workspace.optional(),
    legacyRoot: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    files: z.array(z.string()),
  })
  export type Range = z.infer<typeof Range>

  export function key(range: Pick<Range, "workspace" | "legacyRoot">) {
    return range.workspace
      ? JSON.stringify([range.workspace.id, range.workspace.generation, range.workspace.root])
      : JSON.stringify(["legacy", range.legacyRoot ?? null])
  }

  export function merge(previous: Range[], next: Range[]): Range[] {
    const result = new Map<string, Range>()
    for (const range of [...previous, ...next]) {
      const identity = key(range)
      const existing = result.get(identity)
      result.set(identity, {
        ...range,
        from: existing?.from ?? range.from,
        to: range.to ?? existing?.to,
        files: [...new Set([...(existing?.files ?? []), ...range.files])],
      })
    }
    return [...result.values()]
  }

  export function fromMessages(messages: MessageV2.WithParts[]): Range[] {
    const result: Range[] = []
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "patch" && part.type !== "step-start" && part.type !== "step-finish") continue
        const root = part.workspace?.root ?? (message.info.role === "assistant" ? message.info.path?.cwd : undefined)
        const range: Range = {
          ...(part.workspace ? { workspace: part.workspace } : root ? { legacyRoot: root } : {}),
          ...(part.type === "step-start" ? { from: part.snapshot } : {}),
          ...(part.type === "step-finish" ? { to: part.snapshot } : {}),
          files:
            part.type === "patch"
              ? part.files.flatMap((file) => {
                  const relative = root && path.isAbsolute(file) ? path.relative(root, file) : file
                  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return []
                  return [process.platform === "win32" ? relative.replaceAll("\\", "/") : relative]
                })
              : [],
        }
        result.push(range)
      }
    }
    return merge([], result)
  }
}
