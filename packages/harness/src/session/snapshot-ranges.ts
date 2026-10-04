import path from "node:path"
import { z } from "zod"
import { SnapshotSchema } from "./snapshot-schema"
import type { MessageV2 } from "./message-v2"

export namespace SnapshotRanges {
  export const Range = z.object({
    workspace: SnapshotSchema.Workspace.optional(),
    operationID: z.string().optional(),
    checkpointID: z.string().optional(),
    started: z.number().optional(),
    pending: z.boolean().optional(),
    omissions: z.array(SnapshotSchema.Omission).optional(),
    baselineOmissions: z.array(SnapshotSchema.Omission).optional(),
    endpointOmissions: z.array(SnapshotSchema.Omission).optional(),
    rootID: z.string().optional(),
    issue: SnapshotSchema.Issue.shape.code.optional(),
    incomplete: z.boolean().optional(),
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
      const identity = range.checkpointID
        ? JSON.stringify(["checkpoint", range.checkpointID, key(range)])
        : range.operationID
          ? JSON.stringify(["operation", range.operationID, key(range)])
          : JSON.stringify(["legacy", range.rootID, key(range)])
      const existing = result.get(identity)
      if (range.operationID || range.checkpointID) {
        result.set(identity, existing && !existing.incomplete && range.incomplete ? existing : range)
        continue
      }
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
        if (part.type !== "patch" && !part.snapshot) continue
        const root = part.workspace?.root ?? (message.info.role === "assistant" ? message.info.path?.cwd : undefined)
        const range: Range = {
          rootID:
            part.type === "patch" && part.checkpoint
              ? part.checkpoint.rootID
              : (message.info.rootID ?? message.info.id),
          started: part.type === "patch" && part.checkpoint ? part.checkpoint.started : message.info.time.created,
          ...(part.workspace ? { workspace: part.workspace } : root ? { legacyRoot: root } : {}),
          ...(part.type === "patch" && part.operation
            ? {
                operationID: part.id,
                from: part.hash || undefined,
                ...(part.operation.status === "complete" ? { to: part.operation.afterHash } : { incomplete: true }),
              }
            : {}),
          ...(part.type === "patch" && part.checkpoint
            ? {
                checkpointID: part.id,
                issue: part.checkpoint.error,
                baselineOmissions: part.checkpoint.baselineOmissions ?? part.checkpoint.omissions,
                endpointOmissions: part.checkpoint.omissions,
                omissions: [...(part.checkpoint.baselineOmissions ?? []), ...(part.checkpoint.omissions ?? [])],
                from: part.hash || undefined,
                to: part.checkpoint.afterHash,
                ...(part.checkpoint.status === "pending"
                  ? { pending: true, incomplete: true }
                  : part.checkpoint.status === "incomplete"
                    ? { incomplete: true }
                    : {}),
              }
            : {}),
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

  export function net(ranges: Range[]): Range[] {
    const groups = new Map<string, Range>()
    const checkpoints = new Set(
      ranges.filter((range) => range.checkpointID).map((range) => JSON.stringify([key(range), range.rootID])),
    )
    for (const range of [...ranges].sort((a, b) => (a.started ?? 0) - (b.started ?? 0))) {
      if (!range.checkpointID && checkpoints.has(JSON.stringify([key(range), range.rootID]))) continue
      const identity = key(range)
      const previous = groups.get(identity)
      const baselineOmissions = previous ? previous.baselineOmissions : (range.baselineOmissions ?? range.omissions)
      const endpointOmissions = range.to ? (range.endpointOmissions ?? range.omissions) : previous?.endpointOmissions
      groups.set(
        identity,
        previous
          ? {
              ...range,
              operationID: undefined,
              checkpointID: previous.checkpointID ?? range.checkpointID,
              from: previous.from,
              to: range.to ?? previous.to,
              incomplete: !previous.from || range.incomplete || previous.issue === "legacy_range" || undefined,
              pending: range.pending,
              issue: !previous.from
                ? previous.issue
                : (range.issue ?? (previous.issue === "legacy_range" ? previous.issue : undefined)),
              baselineOmissions,
              endpointOmissions,
              omissions: [...(baselineOmissions ?? []), ...(endpointOmissions ?? [])],
              files: [...new Set([...previous.files, ...range.files])],
            }
          : { ...range, operationID: undefined, baselineOmissions, endpointOmissions },
      )
    }
    return [...groups.values()]
  }
}
