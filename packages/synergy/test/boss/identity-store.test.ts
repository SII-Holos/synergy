import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { BossIdentity } from "../../src/boss/identity"
import { LibraryDB, closeDB } from "../../src/library/database"
import { Embedding } from "../../src/vector/embedding"

const originalEmbeddingGenerate = Embedding.generate

function stubEmbedding(): void {
  ;(Embedding.generate as any) = mock(async (input: { id: string; text: string }) => ({
    id: input.id,
    vector: [0.1, 0.2, 0.3, 0.4],
    model: "test-embedding",
  }))
}

describe("BossIdentity name store", () => {
  beforeEach(() => {
    closeDB()
    LibraryDB.Memory.removeAll()
    stubEmbedding()
  })

  afterEach(() => {
    ;(Embedding.generate as any) = originalEmbeddingGenerate
    LibraryDB.Memory.removeAll()
    closeDB()
  })

  test("getBossName returns undefined when no name row exists", () => {
    expect(BossIdentity.getBossName()).toBeUndefined()
  })

  test("setBossName creates a search_only self memory row and getBossName reads it", async () => {
    const result = await BossIdentity.setBossName("小飞")
    expect(result.created).toBe(true)
    expect(result.removed).toBe(false)
    expect(result.id).toBeDefined()

    const rows = LibraryDB.Memory.list({ categories: ["self"] })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe(BossIdentity.NAME_MEMORY_TITLE)
    expect(rows[0].content).toBe("小飞")
    expect(rows[0].category).toBe("self")
    expect(rows[0].recall_mode).toBe("search_only")
    expect(BossIdentity.getBossName()).toBe("小飞")
  })

  test("setBossName is an idempotent upsert — one row, updated content", async () => {
    await BossIdentity.setBossName("小飞")
    const second = await BossIdentity.setBossName("阿杰")
    expect(second.created).toBe(false)
    expect(second.removed).toBe(false)

    const rows = LibraryDB.Memory.list({ categories: ["self"] })
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("阿杰")
    expect(BossIdentity.getBossName()).toBe("阿杰")
  })

  test("setBossName with an empty value removes the stored name", async () => {
    await BossIdentity.setBossName("小飞")
    const removed = await BossIdentity.setBossName("   ")
    expect(removed.removed).toBe(true)
    expect(BossIdentity.getBossName()).toBeUndefined()
    expect(LibraryDB.Memory.list({ categories: ["self"] })).toHaveLength(0)
  })

  test("setBossName with an empty value when nothing is stored is a no-op", async () => {
    const result = await BossIdentity.setBossName("")
    expect(result.created).toBe(false)
    expect(result.removed).toBe(false)
    expect(BossIdentity.getBossName()).toBeUndefined()
  })

  test("only the boss_name row is treated as the name (other self rows are ignored)", async () => {
    await BossIdentity.setBossName("小飞")
    const id = Identifier("other-self")
    LibraryDB.Memory.insert(
      {
        id,
        title: "my operating role",
        content: "unrelated self memory",
        category: "self",
        recallMode: "always",
      },
      { id, vector: [0.5, 0.5, 0.5, 0.5], model: "test-embedding" },
    )
    expect(BossIdentity.getBossName()).toBe("小飞")
  })
})

function Identifier(seed: string): string {
  return `mem_${seed}_${Date.now().toString(36)}`
}
