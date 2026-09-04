import { LibraryDB } from "../library/database"
import { Embedding } from "../vector/embedding"
import { Identifier } from "../id/id"

/**
 * Runtime boss name persistence (R3). The name is a single runtime-level value
 * stored as a `self` memory row with the fixed title `boss_name`, so it shares
 * the Library identity memory surface (visible in the Library UI and to
 * memory_search) without creating a new storage domain.
 *
 * The row is deliberately `search_only`: it is consumed by the persona renderer
 * through a direct title lookup, and `always` would inject the boss name into
 * every ordinary session's active memory (each agent would see itself as the
 * boss). `search_only` keeps normal sessions clean while the boss persona still
 * carries the name every turn.
 */
export namespace BossIdentity {
  export const NAME_MEMORY_TITLE = "boss_name"

  /** Read the current boss name, or undefined when unset/empty. */
  export function getBossName(): string | undefined {
    const row = findNameRow()
    return row?.content.trim() || undefined
  }

  /**
   * Upsert the boss name as a `self` memory row. Passing an empty/whitespace
   * string clears the stored name (removes the row). Returns the row id and
   * whether the row was created.
   */
  export async function setBossName(name: string): Promise<{ id?: string; created: boolean; removed: boolean }> {
    const trimmed = name.trim()
    const existing = findNameRow()
    if (!trimmed) {
      if (existing) {
        LibraryDB.Memory.remove(existing.id)
        return { id: existing.id, created: false, removed: true }
      }
      return { id: undefined, created: false, removed: false }
    }

    const id = existing?.id ?? Identifier.ascending("memory")
    const embedding = await Embedding.generate({ id, text: `${NAME_MEMORY_TITLE}\n${trimmed}` })
    if (existing) {
      LibraryDB.Memory.update(
        {
          id,
          title: NAME_MEMORY_TITLE,
          content: trimmed,
          category: "self",
          recallMode: "search_only",
        },
        embedding,
      )
      return { id, created: false, removed: false }
    }
    LibraryDB.Memory.insert(
      {
        id,
        title: NAME_MEMORY_TITLE,
        content: trimmed,
        category: "self",
        recallMode: "search_only",
      },
      embedding,
    )
    return { id, created: true, removed: false }
  }

  function findNameRow(): LibraryDB.Memory.Row | undefined {
    return LibraryDB.Memory.list({ categories: ["self"] }).find((row) => row.title === NAME_MEMORY_TITLE)
  }
}
