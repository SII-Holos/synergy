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
  let pending: string[][] = []
  async function flush() {
    if (!pending.length) return
    const keys = pending
    pending = []
    await Storage.transaction(async (tx) => {
      const values = await tx.readMany<Record<string, unknown>>(keys)
      const changed: Array<{ key: string[]; value: Record<string, unknown> }> = []
      for (const [index, key] of keys.entries()) {
        const value = values[index]
        if (value === undefined) throw new Storage.NotFoundError({ message: "Storage record does not exist" })
        if (upgradeCompactionCoverage(key, value)) changed.push({ key, value })
      }
      if (changed.length) await tx.writeMany(changed)
    })
    for (let index = 0; index < keys.length; index++) progress(++done, 0)
  }
  for await (const entry of Storage.records<Record<string, unknown>>({ kind: "message", ...owner })) {
    await UpgradeWork.checkpoint()
    pending.push(entry.key)
    if (pending.length >= 128) await flush()
  }
  await flush()
  progress(done, done)
}
