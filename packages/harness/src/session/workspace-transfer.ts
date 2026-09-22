import type { MessageV2 } from "./message-v2"
import type { SessionExport } from "./session-export"
import type { SnapshotSchema } from "./snapshot-schema"

export namespace WorkspaceTransfer {
  function partSource(part: MessageV2.Part) {
    if (part.type === "patch" || part.type === "snapshot" || part.type === "step-start" || part.type === "step-finish")
      return part.workspace
  }

  export function sources(data: SessionExport.SessionData[]): SnapshotSchema.Workspace[] {
    return data.flatMap((session) => [
      ...session.diffs.flatMap((diff) => (diff.workspace ? [diff.workspace] : [])),
      ...session.messages.flatMap((message) => [
        ...message.parts.flatMap((part) => {
          const source = partSource(part)
          return source ? [source] : []
        }),
        ...(message.info.role === "user"
          ? (message.info.summary?.diffs.flatMap((diff) => (diff.workspace ? [diff.workspace] : [])) ?? [])
          : []),
      ]),
    ])
  }

  export function references(data: SessionExport.SessionData[]) {
    return new Set([
      ...data.flatMap((session) => (session.info.workspaceID ? [session.info.workspaceID] : [])),
      ...sources(data).map((source) => source.id),
    ])
  }

  function remap(source: SnapshotSchema.Workspace, ids: ReadonlyMap<string, string>) {
    const id = ids.get(source.id)
    if (!id) throw new Error("Historical Workspace was not imported")
    return { ...source, id }
  }

  export function diff(diff: SnapshotSchema.FileDiff, ids: ReadonlyMap<string, string>): SnapshotSchema.FileDiff {
    return diff.workspace ? { ...diff, workspace: remap(diff.workspace, ids) } : diff
  }

  export function message(message: MessageV2.WithParts, ids: ReadonlyMap<string, string>): MessageV2.WithParts {
    return {
      info:
        message.info.role === "user" && message.info.summary
          ? {
              ...message.info,
              summary: { ...message.info.summary, diffs: message.info.summary.diffs.map((value) => diff(value, ids)) },
            }
          : message.info,
      parts: message.parts.map((part) => {
        if (
          part.type !== "patch" &&
          part.type !== "snapshot" &&
          part.type !== "step-start" &&
          part.type !== "step-finish"
        )
          return part
        return part.workspace ? { ...part, workspace: remap(part.workspace, ids) } : part
      }),
    }
  }
}
