import type { MemoryCategory, MemoryInfo, MemoryRecallMode } from "@ericsanchezok/synergy-sdk/client"

/** Fixed memory title for the boss colleague name (shared self memory row). */
export const BOSS_NAME_MEMORY_TITLE = "boss_name"

export type BossNameMemoryInput = {
  title: string
  content: string
  category: MemoryCategory
  recallMode: MemoryRecallMode
}

/** Narrow SDK seam used to read and upsert the boss name self-memory row. */
export type BossNameGateway = {
  listSelfMemories(): Promise<MemoryInfo[]>
  createMemory(input: BossNameMemoryInput): Promise<unknown>
  updateMemory(input: BossNameMemoryInput & { id: string }): Promise<unknown>
}

/** Extract the stored boss name (trimmed) from a self-category memory list. */
export function bossNameFromRows(rows: Pick<MemoryInfo, "id" | "title" | "content">[]): string {
  const row = rows.find((candidate) => candidate.title === BOSS_NAME_MEMORY_TITLE)
  return row?.content.trim() ?? ""
}

/**
 * Upsert the boss name into the shared self memory. An empty/whitespace draft
 * never touches the library (the stored row is left for the user to remove
 * manually), and an existing `boss_name` row is updated in place rather than
 * duplicated.
 */
export async function saveBossName(
  gateway: BossNameGateway,
  rawName: string,
): Promise<"created" | "updated" | "skipped"> {
  const content = rawName.trim()
  if (!content) return "skipped"

  const rows = await gateway.listSelfMemories()
  const existing = rows.find((row) => row.title === BOSS_NAME_MEMORY_TITLE)
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
