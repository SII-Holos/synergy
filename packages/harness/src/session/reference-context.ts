import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"
import { SessionHistoryDisplay } from "./history-display"

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function historicalReferenceContext(
  info: Record<string, unknown>,
  sources: ResourceReference.Workspace[],
): ResourceReference.Context {
  const recorded = ResourceReference.Context.safeParse(info.referenceContext)
  if (recorded.success && recorded.data.state !== "unresolved") return recorded.data
  const path = object(info.path)
  if (info.role === "assistant" && path?.cwd === null && path.root === null) return { state: "none" }
  if (typeof path?.cwd !== "string") return { state: "unresolved" }
  const candidates = new Map<string, Extract<ResourceReference.Context, { state: "bound" }>>()
  for (const workspace of sources) {
    const context = { state: "bound" as const, workspace, directory: "" }
    const directory = ResourceReference.resolvePath(path.cwd, context)
    if (directory !== undefined) candidates.set(JSON.stringify(workspace), { ...context, directory })
  }
  return candidates.size === 1 ? candidates.values().next().value! : { state: "unresolved" }
}

export function upgradeReferenceContext(key: string[], value: Record<string, unknown>) {
  if (
    key[0] === "sessions" &&
    key.length === 6 &&
    key[3] === "messages" &&
    key[5] === "info" &&
    !value.referenceContext
  )
    value.referenceContext = historicalReferenceContext(value, [])
}

export async function migrateReferenceContexts(
  owner: { scopeID: string; sessionID: string },
  progress: (current: number, total: number) => void,
) {
  let done = 0
  let writes: Array<{ key: string[]; value: Record<string, unknown> }> = []
  let bytes = 0
  let invalidated = false
  const flush = async () => {
    if (!writes.length) return
    await Storage.transaction(async (tx) => {
      await tx.writeMany(writes)
      await SessionHistoryDisplay.invalidate(owner.scopeID, owner.sessionID)
    })
    invalidated = true
    writes = []
    bytes = 0
  }
  for await (const entry of Storage.records<Record<string, unknown>>({ kind: "message", ...owner })) {
    await UpgradeWork.checkpoint()
    const current = ResourceReference.Context.safeParse(entry.value.referenceContext)
    if (current.success && current.data.state !== "unresolved") {
      progress(++done, 0)
      continue
    }
    const sources: ResourceReference.Workspace[] = []
    if (typeof object(entry.value.path)?.cwd === "string")
      for await (const part of Storage.records<Record<string, unknown>>({
        kind: "part",
        ...owner,
        prefix: [...entry.key.slice(0, 5), "parts"],
      })) {
        await UpgradeWork.checkpoint()
        const source = ResourceReference.Workspace.safeParse(part.value.workspace)
        if (
          source.success &&
          !sources.some(
            (item) =>
              item.id === source.data.id &&
              item.generation === source.data.generation &&
              item.root === source.data.root,
          )
        )
          sources.push(source.data)
      }
    const referenceContext = historicalReferenceContext(entry.value, sources)
    if (JSON.stringify(referenceContext) !== JSON.stringify(entry.value.referenceContext)) {
      const value = { ...entry.value, referenceContext }
      const size = Buffer.byteLength(JSON.stringify(value))
      if (writes.length >= 100 || bytes + size > 4 * 1024 * 1024) await flush()
      writes.push({ key: entry.key, value })
      bytes += size
    }
    progress(++done, 0)
  }
  await flush()
  if (!invalidated) await SessionHistoryDisplay.invalidate(owner.scopeID, owner.sessionID)
  progress(done, done)
}
