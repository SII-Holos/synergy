import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool } from "../../src/tools/memory"
import { LibraryDB, closeDB } from "../../src/database"
import { Embedding } from "../../src/vector/embedding"
import { Rerank } from "../../src/vector/rerank"
import { MemoryRecall } from "../../src/memory-recall"

const ctx = {
  sessionID: "memory-tool-session",
  messageID: "memory-tool-message",
  agent: "synergy",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}
afterEach(async () => {
  LibraryDB.Memory.removeAll()
  closeDB()
  await Embedding.resetForTest()
})

test("memory tools write deduplicate edit search and get through real vector storage and HTTP embeddings", async () => {
  let fail = false
  const requests: Array<{ url: string; body: unknown; auth: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      requests.push({ url: new URL(request.url).pathname, body, auth: request.headers.get("authorization") })
      if (fail) return new Response("model unavailable", { status: 400 })
      if (new URL(request.url).pathname.endsWith("rerank"))
        return Response.json({ results: [{ index: 0, relevance_score: 0.95, document: { text: "evidence" } }] })
      return Response.json({
        data: [{ index: 0, embedding: [1, 0, 0, 0] }],
        model: "fixture-embedding",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    },
  })
  try {
    await using tmp = await tmpdir({
      config: {
        embedding: { apiKey: "fixture-key", baseURL: server.url.href, model: "fixture-embedding" },
        rerank: { baseURL: server.url.href, model: "fixture-rerank" },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const write = await MemoryWriteTool.init()
        const edit = await MemoryEditTool.init()
        const get = await MemoryGetTool.init()
        const search = await MemorySearchTool.init()
        const input = {
          title: "Research preference",
          content: "Use reproducible trials",
          category: "user" as const,
          recallMode: "contextual" as const,
        }
        const written = await write.execute(input, ctx)
        const id = String(written.metadata.id)
        expect(LibraryDB.Memory.get(id)?.content).toBe(input.content)
        expect((await write.execute(input, ctx)).metadata.action).toBe("similar_found")
        expect(LibraryDB.Memory.count()).toBe(1)
        const edited = await edit.execute({ ...input, id, content: "Use seeded reproducible trials" }, ctx)
        expect(edited.output).toContain("updated successfully")
        expect(LibraryDB.Memory.get(id)?.content).toContain("seeded")
        expect((await edit.execute({ ...input, id: "absent" }, ctx)).output).toContain("not found")
        expect((await get.execute({ ids: [id] }, ctx)).output).toContain("seeded")
        expect((await get.execute({ ids: ["absent"] }, ctx)).metadata.count).toBe(0)
        expect((await search.execute({ query: "trials", top_k: 5 }, ctx)).metadata.count).toBe(1)
        expect((await search.execute({ query: "trials", top_k: 5, categories: ["asset"] }, ctx)).metadata.count).toBe(0)
        expect(await Rerank.rerank({ query: "trial", documents: ["evidence"], topN: 1 })).toEqual([
          { index: 0, relevanceScore: 0.95, document: "evidence" },
        ])
        expect((await MemoryRecall.search({ query: "trials", rerank: true, topK: 1 }))[0]?.id).toBe(id)
        const calls = requests.length
        expect(await Rerank.rerank({ query: "trial", documents: [] })).toEqual([])
        expect(requests).toHaveLength(calls)
        expect(requests.every((request) => request.auth === "Bearer fixture-key")).toBe(true)
        fail = true
        await expect(Rerank.rerank({ query: "trial", documents: ["evidence"] })).rejects.toThrow("Rerank API error 400")
        expect((await write.execute({ ...input, title: "Failed write" }, ctx)).output).toContain(
          "Failed to generate embedding",
        )
        expect((await edit.execute({ ...input, id }, ctx)).output).toContain("Failed to generate embedding")
        expect(LibraryDB.Memory.count()).toBe(1)
        expect(LibraryDB.Memory.get(id)?.content).toContain("seeded")
      },
    })
  } finally {
    await server.stop(true)
  }
}, 30_000)

test("local embedding owner loads once, reports progress, retries the mirror and releases resources", async () => {
  await using tmp = await tmpdir({ config: { embedding: { local: { source: "huggingface" } } } })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      let loads = 0
      let disposed = 0
      let pipelines = 0
      const hosts: string[] = []
      const ready = Promise.withResolvers<void>()
      const extracting = Promise.withResolvers<void>()
      const extractor = Object.assign(async () => ({ data: new Float32Array([0.5, 0.25]) }), {
        async dispose() {
          disposed++
        },
      })
      Embedding.setLocalRuntimeControlsForTest({
        loadRuntime: async () => {
          loads++
          return {
            configure(input) {
              hosts.push(input.remoteHost)
            },
            async isCached() {
              return false
            },
            async pipeline(_task, _model, options) {
              pipelines++
              options.progress_callback({ status: "progress_total", loaded: 20, total: 80, progress: 25 })
              if (pipelines === 1) throw new Error("primary source unreachable")
              extracting.resolve()
              await ready.promise
              return extractor
            },
          }
        },
      })
      expect(await Embedding.status()).toMatchObject({ mode: "local", runtime: "unloaded", asset: "missing" })
      const warmup = Embedding.warmup()
      await extracting.promise
      expect(await Embedding.status()).toMatchObject({
        runtime: "loading",
        source: "hf-mirror",
        progress: { loadedBytes: 20, totalBytes: 80, percent: 25 },
      })
      const second = Embedding.warmup()
      ready.resolve()
      await Promise.all([warmup, second])
      expect(pipelines).toBe(2)
      expect(hosts.at(-1)).toBe("https://hf-mirror.com/")
      expect(await Embedding.status()).toMatchObject({
        runtime: "ready",
        source: "hf-mirror",
        progress: { loadedBytes: 80, totalBytes: 80, percent: 100 },
      })
      const batch = await Embedding.generateBatch([
        { id: "local-a", text: "first" },
        { id: "local-b", text: "second" },
      ])
      expect(batch.map((item) => item.vector)).toEqual([
        [0.5, 0.25],
        [0.5, 0.25],
      ])
      expect(await Embedding.generateBatch([])).toEqual([])
      expect(loads).toBe(2)
      await Embedding.dispose()
      await Embedding.dispose()
      expect(disposed).toBe(1)
      const signal = AbortSignal.abort(new Error("cancelled before extraction"))
      await expect(Embedding.generate({ id: "cancelled", text: "ignored", signal })).rejects.toThrow(
        "cancelled before extraction",
      )
      expect(pipelines).toBe(2)
    },
  })
})

test("memory recall falls back to ranked persisted text when the remote embedding service is unavailable", async () => {
  let requests = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response("embedding unavailable", { status: 400 })
    },
  })
  await using tmp = await tmpdir({
    config: {
      embedding: { apiKey: "fixture-key", baseURL: server.url.href, model: "fixture-unavailable" },
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      for (const [id, content] of [
        ["strong", "reproducible reproducible reproducible trial"],
        ["weak", "one reproducible observation"],
        ["unrelated", "ordinary notes"],
      ]) {
        LibraryDB.Memory.insert(
          { id: id!, title: id!, content: content!, category: "general", recallMode: "contextual" },
          { id: id!, vector: [1, 0, 0, 0], model: "fixture" },
        )
      }
      const result = await MemoryRecall.search({ query: "reproducible", topK: 2 })
      expect(result.map((memory) => memory.id)).toEqual(["strong", "weak"])
      expect(result[0]?.content).toContain("reproducible reproducible reproducible")
      expect(result[0]?.similarity).toBe(3)
      expect(result[1]?.similarity).toBe(1)
      expect(await MemoryRecall.search({ query: "missing-term", topK: 3 })).toEqual([])
      expect((await MemoryRecall.search({ query: "x", topK: 1 })).length).toBe(1)
      expect(requests).toBeGreaterThan(0)
      expect(LibraryDB.Memory.count()).toBe(3)
    },
  })
})
