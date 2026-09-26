import type { MessageV2 } from "./message-v2"
import type { SessionExport } from "./session-export"
import type { SnapshotSchema } from "./snapshot-schema"
import { Workspace } from "./workspace-schema"
import { ScopeTransfer } from "../scope/transfer"

export namespace WorkspaceTransfer {
  export type Reference = { id: string; scopeID: string; legacy?: Workspace }
  export type Resolve = (reference: Reference) => string

  function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  }

  export function selection(
    value: Record<string, unknown>,
    scopeID: string,
    resolve: Resolve,
    relocate?: ScopeTransfer.Relocate,
  ) {
    const sourceScope = object(value.scope)?.id
    if (typeof sourceScope === "string" && sourceScope !== scopeID)
      throw new Error("Imported Workspace owner belongs to another Scope")
    const { workspace, ...result } = value
    if (relocate && result.scope) result.scope = ScopeTransfer.paths(result.scope, relocate)
    if (typeof result.workspaceID === "string")
      return { ...result, workspaceID: resolve({ id: result.workspaceID, scopeID }) }
    if (result.workspaceID === null || workspace === null) return { ...result, workspaceID: null }
    const directory = object(object(value.scope)?.local)?.directory
    const legacy =
      workspace !== undefined
        ? Workspace.parse(workspace)
        : typeof directory === "string"
          ? { type: "main", path: directory, scopeID }
          : undefined
    if (!legacy) return { ...result, workspaceID: null }
    if (legacy.scopeID !== scopeID) throw new Error("Imported Workspace belongs to another Scope")
    return {
      ...result,
      workspaceID: resolve({ id: legacy.id ?? `legacy:${JSON.stringify([scopeID, legacy.path])}`, scopeID, legacy }),
    }
  }

  export function record(key: string[], value: unknown, resolve: Resolve, relocate?: ScopeTransfer.Relocate): unknown {
    if (key[0] !== "sessions") return value
    const scopeID = key[1]!
    const source = (value: unknown) => {
      const record = object(value)
      const workspace = object(record?.workspace)
      return record && typeof workspace?.id === "string"
        ? { ...record, workspace: { ...workspace, id: resolve({ id: workspace.id, scopeID }) } }
        : value
    }
    const summary = (value: Record<string, unknown>) => {
      const summary = object(value.summary)
      return summary && Array.isArray(summary.diffs)
        ? { ...value, summary: { ...summary, diffs: summary.diffs.map(source) } }
        : value
    }
    const record = object(value)
    if (key.length === 4 && key[3] === "info" && record) return summary(selection(record, scopeID, resolve, relocate))
    if (key.length === 4 && key[3] === "summary" && Array.isArray(value)) return value.map(source)
    if (key.length === 4 && key[3] === "summary_cursor" && record && Array.isArray(record.ranges))
      return { ...record, ranges: record.ranges.map(source) }
    if (key[3] !== "messages" || !record) return value
    if (key.length === 6 && key[5] === "info" && record.role === "user") return summary(record)
    if (
      key.length === 7 &&
      key[5] === "parts" &&
      ["patch", "snapshot", "step-start", "step-finish"].includes(String(record.type))
    )
      return source(record)
    return value
  }

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
