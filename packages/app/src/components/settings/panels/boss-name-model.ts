import type { MemoryCategory, MemoryInfo, MemoryRecallMode } from "@ericsanchezok/synergy-sdk/client"

/** Fixed memory title for the boss colleague name (shared self memory row). */
export const BOSS_NAME_MEMORY_TITLE = "boss_name"

export type BossNameMemoryInput = {
  title: string
  content: string
  category: MemoryCategory
  recallMode: MemoryRecallMode
}

/** Narrow SDK seam used to read, upsert, and remove the boss name self-memory row. */
export type BossNameGateway = {
  listSelfMemories(): Promise<MemoryInfo[]>
  createMemory(input: BossNameMemoryInput): Promise<unknown>
  updateMemory(input: BossNameMemoryInput & { id: string }): Promise<unknown>
  removeMemory(id: string): Promise<unknown>
}

/** Extract the stored boss name (trimmed) from a self-category memory list. */
export function bossNameFromRows(rows: Pick<MemoryInfo, "id" | "title" | "content">[]): string {
  const row = rows.find((candidate) => candidate.title === BOSS_NAME_MEMORY_TITLE)
  return row?.content.trim() ?? ""
}

/**
 * Sync the shared self-memory row with the draft name. A non-empty draft
 * creates the `boss_name` row when missing and updates the existing row in
 * place otherwise (never duplicates). An empty/whitespace draft removes the
 * stored row when one exists and otherwise touches nothing.
 */
export async function saveBossName(
  gateway: BossNameGateway,
  rawName: string,
): Promise<"created" | "updated" | "removed" | "skipped"> {
  const content = rawName.trim()

  const rows = await gateway.listSelfMemories()
  const existing = rows.find((row) => row.title === BOSS_NAME_MEMORY_TITLE)
  if (!content) {
    if (existing) {
      await gateway.removeMemory(existing.id)
      return "removed"
    }
    return "skipped"
  }
  if (existing) {
    await gateway.updateMemory({
      id: existing.id,
      title: BOSS_NAME_MEMORY_TITLE,
      content,
      category: "self",
      recallMode: "search_only",
    })
    return "updated"
  }
  await gateway.createMemory({
    title: BOSS_NAME_MEMORY_TITLE,
    content,
    category: "self",
    recallMode: "search_only",
  })
  return "created"
}

/**
 * Serialize boss name writes through one promise chain so blur and unmount
 * flushes of the same draft cannot race into duplicate rows. Every persist()
 * waits for earlier queued writes and becomes a no-op when the content already
 * matches the last successfully persisted name. A failed write rejects only
 * its own persist() promise and never blocks later queued writes.
 */
export function createBossNamePersister(gateway: BossNameGateway) {
  let lastSavedName = ""
  // The chain always resolves; failures surface on the persist() promise of
  // the failed write, not on later queued writes.
  let chain: Promise<void> = Promise.resolve()

  const persist = (rawName: string): Promise<void> => {
    const content = rawName.trim()
    const job = chain.then(async () => {
      // The no-op check runs only after earlier queued writes have settled,
      // so a second flush of the same draft never issues a second write.
      if (content === lastSavedName) return
      await saveBossName(gateway, content)
      lastSavedName = content
    })
    chain = job.catch(() => {})
    return job
  }

  return {
    /** Schedule a save of `rawName`; earlier scheduled saves finish first. */
    persist,
    /** Content of the last successfully persisted name ("" when none or removed). */
    getLastSavedName: (): string => lastSavedName,
    /** Record content already stored in the gateway (mount backfill) without writing. */
    adoptStoredName: (name: string): void => {
      lastSavedName = name.trim()
    },
  }
}
