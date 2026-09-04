import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { Embedding } from "../../src/vector/embedding"
import { LibraryDB, closeDB } from "../../src/library/database"
import { LibraryRoute } from "../../src/server/library"

const originalConfigCurrent = Config.current
const originalEmbeddingGenerate = Embedding.generate

function app() {
  return new Hono().route("/library", LibraryRoute)
}

function stubEmbedding(): void {
  ;(Embedding.generate as unknown) = mock(async (input: { id: string; text: string }) => ({
    id: input.id,
    vector: [0.1, 0.2, 0.3, 0.4],
    model: "test-embedding",
  }))
}

beforeEach(async () => {
  closeDB()
  LibraryDB.Memory.removeAll()
  stubEmbedding()
  ;(Config.current as typeof Config.current) = mock(async () => ({}))
})

afterEach(async () => {
  ;(Embedding.generate as unknown) = originalEmbeddingGenerate
  LibraryDB.Memory.removeAll()
  closeDB()
  ;(Config.current as typeof Config.current) = originalConfigCurrent
})

describe("Library memory create/update API (boss name + persona settings path)", () => {
  test("creates a memory row with an embedding and returns the memory card", async () => {
    const response = await app().request("/library/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "boss_name",
        content: "小飞",
        category: "self",
        recallMode: "search_only",
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: "boss_name",
        content: "小飞",
        category: "self",
        recallMode: "search_only",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
    )

    const rows = LibraryDB.Memory.list({ categories: ["self"] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: "boss_name", content: "小飞", category: "self", recall_mode: "search_only" })
    expect(rows[0].embedding_model).toBe("test-embedding")
  })

  test("updates an existing memory row and regenerates its embedding", async () => {
    const created = await app().request("/library/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "boss_name",
        content: "小飞",
        category: "self",
        recallMode: "search_only",
      }),
    })
    expect(created.status).toBe(200)
    const createdBody = (await created.json()) as { id: string }

    const updated = await app().request("/library/memory/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: createdBody.id,
        title: "boss_name",
        content: "阿杰",
        category: "self",
        recallMode: "search_only",
      }),
    })

    expect(updated.status).toBe(200)
    const updatedBody = (await updated.json()) as Record<string, unknown>
    expect(updatedBody).toEqual(expect.objectContaining({ id: createdBody.id, content: "阿杰" }))

    const rows = LibraryDB.Memory.list({ categories: ["self"] })
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("阿杰")
  })

  test("update returns 404 when the memory id does not exist", async () => {
    const response = await app().request("/library/memory/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "mem_missing",
        title: "boss_name",
        content: "小飞",
        category: "self",
        recallMode: "search_only",
      }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ message: "Memory not found: mem_missing" })
  })

  test("rejects invalid category and recallMode values", async () => {
    const response = await app().request("/library/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "boss_name",
        content: "小飞",
        category: "not-a-category",
        recallMode: "sometimes",
      }),
    })

    expect(response.status).toBe(400)
    expect(LibraryDB.Memory.list({})).toHaveLength(0)
  })

  test("embedding failure returns 400 and writes no partial row", async () => {
    ;(Embedding.generate as unknown) = mock(async () => {
      throw new Error("no embedding model configured")
    })

    const response = await app().request("/library/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "boss_name",
        content: "小飞",
        category: "self",
        recallMode: "search_only",
      }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain("Memory create failed")
    expect(LibraryDB.Memory.list({})).toHaveLength(0)
  })
})
