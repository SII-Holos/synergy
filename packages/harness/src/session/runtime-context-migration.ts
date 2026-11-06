import { RuntimeContextMetadata } from "./runtime-context-schema"

export function upgradeRuntimeContextRecord(key: string[], value: Record<string, unknown>): boolean {
  if (key[0] !== "sessions" || key.length !== 6 || key[3] !== "messages" || key[5] !== "info" || value.role !== "user")
    return false
  const origin = value.origin as { type?: string; detail?: string } | undefined
  if (origin?.type !== "system" || origin.detail !== "runtime-context") return false
  const metadata = value.metadata as Record<string, unknown> | undefined
  const context = metadata?.runtimeContext as Record<string, unknown> | undefined
  if (context?.version !== 1) return false
  const upgraded = RuntimeContextMetadata.parse(context)
  const sources = context.sources as Record<string, unknown>[]
  value.metadata = {
    ...metadata,
    runtimeContext: {
      ...context,
      ...upgraded,
      sources: upgraded.sources.map((source, index) => ({ ...sources[index], ...source })),
    },
  }
  return true
}

export async function migrateRuntimeContext(
  owner: { scopeID: string; sessionID: string },
  progress: (current: number, total: number) => void,
) {
  const [{ Storage }, { UpgradeWork }] = await Promise.all([
    import("../storage/storage"),
    import("../storage/upgrade-work"),
  ])
  let done = 0
  for await (const entry of Storage.records<Record<string, unknown>>({ kind: "message", ...owner })) {
    await UpgradeWork.checkpoint()
    const value = structuredClone(entry.value)
    if (upgradeRuntimeContextRecord(entry.key, value)) await Storage.write(entry.key, value)
    progress(++done, 0)
  }
  progress(done, done)
}
