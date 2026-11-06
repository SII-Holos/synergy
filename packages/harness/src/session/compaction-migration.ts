import { z } from "zod"
import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"

const Summary = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  summary: z.literal(true),
  finish: z.string().min(1),
  time: z.object({ created: z.number() }),
})

export function upgradeCompactionCoverage(key: string[], value: Record<string, unknown>) {
  if (
    key[0] !== "sessions" ||
    key.length !== 6 ||
    key[3] !== "messages" ||
    key[5] !== "info" ||
    value.compaction !== undefined
  )
    return false
  const parsed = Summary.safeParse(value)
  if (!parsed.success) return false
  value.compaction = { coveredThrough: { created: parsed.data.time.created, messageID: parsed.data.id } }
  return true
}

export async function migrateCompactionCoverage(
  owner: { scopeID: string; sessionID: string },
  progress: (current: number, total: number) => void,
) {
  let done = 0
  for await (const entry of Storage.records<Record<string, unknown>>({ kind: "message", ...owner })) {
    await UpgradeWork.checkpoint()
    await Storage.transaction(async () => {
      const value = await Storage.read<Record<string, unknown>>(entry.key)
      if (upgradeCompactionCoverage(entry.key, value)) await Storage.write(entry.key, value)
    })
    progress(++done, 0)
  }
  progress(done, done)
}
