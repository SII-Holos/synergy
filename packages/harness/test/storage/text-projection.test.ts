import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { SqliteDriver } from "../../src/storage/sqlite-driver"
import { storageTestOptions } from "../support/storage-backends"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { TextSearch } from "../../src/util/text-search"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const key = ["sessions", "scope", "session", "messages", "message", "parts", "part"]

test("indexed and replay ranking share message budgets, identity ties and fragment boundaries", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: `replay-${randomUUID()}`, filename: path.join(tmp.path, "agent.sqlite") }),
    )
    try {
      const entries = Array.from({ length: 100 }, (_, index) => ({
        identity: `scope/session/message-${index}`,
        parts: [index % 3 ? "api boundary" : " ".repeat(8189) + "longidentifier api boundary"],
      }))
      for (const [index, entry] of entries.entries()) {
        const sourceKey = [...key.slice(0, 4), `message-${index}`, "parts", "part"]
        await store.write(sourceKey, { text: entry.parts[0] })
        const source = await store.versioned(sourceKey)
        await store.transaction((tx) =>
          tx.appendTextProjection({
            key: sourceKey,
            revision: source.revision,
            version: "v1",
            category: "text",
            offset: 0,
            complete: true,
            fragments: TextSearch.fragments(entry.parts[0]!).map((text, index) => ({
              offset: index * TextSearch.fragmentCharacters,
              text,
            })),
          }),
        )
      }
      const terms = ["api", "boundary", "longidentifier", "gidentifier"]
      const actual: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 4; page++) {
        const result = await store.snapshot((tx) => tx.searchTextProjection({ query: "", terms, cursor, limit: 24 }))
        actual.push(...result.items.map((hit) => hit.key.slice(1, 3).concat(hit.key[4]!).join("/")))
        cursor = result.nextCursor ?? undefined
      }
      expect(actual).toEqual(TextSearch.ranked(entries, terms, 96).map((entry) => entry.identity))
      expect(new Set(actual).size).toBe(96)
    } finally {
      await store.close()
    }
  }))

test("multi-term search ranks the whole lexical index before bounded pagination", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: `ranked-${randomUUID()}`, filename: path.join(tmp.path, "agent.sqlite") }),
    )
    try {
      const keys: string[][] = []
      for (let index = 0; index < 102; index++) {
        const item = [...key.slice(0, 4), `message-${index}`, "parts", "part"]
        keys.push(item)
        await store.write(item, { text: "canonical body" })
        const source = await store.versioned(item)
        await store.transaction((tx) =>
          tx.appendTextProjection({
            key: item,
            revision: source.revision,
            version: "ranked-v1",
            category: "text",
            offset: 0,
            fragments: [{ offset: 0, text: index >= 100 ? "架构 ownership boundary" : "架构 unrelated" }],
            complete: true,
          }),
        )
      }
      const long = [...key.slice(0, 4), "long-message", "parts", "part"]
      await store.write(long, { text: "long canonical body" })
      const source = await store.versioned(long)
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key: long,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 0,
          fragments: Array.from({ length: 4 }, (_, index) => ({
            offset: index * 8192,
            text: "架构 ownership boundary",
          })),
          complete: true,
        }),
      )
      const query = { query: "", terms: ["架构", "ownership", "boundary"], limit: 1 }
      expect(
        (await store.snapshot((tx) => tx.searchTextProjection({ ...query, limit: 3 }))).items.map((hit) => hit.key),
      ).toEqual([keys[101]!, keys[100]!, long])
      const first = await store.snapshot((tx) => tx.searchTextProjection(query))
      expect(first.items.map((hit) => hit.key)).toEqual([keys[101]!])
      expect(first.indexed).toBe(true)
      expect(first.scanned).toBe(1)
      const second = await store.snapshot((tx) => tx.searchTextProjection({ ...query, cursor: first.nextCursor! }))
      expect(second.items.map((hit) => hit.key)).toEqual([keys[100]!])
      await store.remove(keys[101]!)
      const afterDelete = await store.snapshot((tx) => tx.searchTextProjection(query))
      expect(afterDelete.items.map((hit) => hit.key)).toEqual([keys[100]!])
      await expect(store.snapshot((tx) => tx.searchTextProjection({ ...query, cursor: "invalid" }))).rejects.toThrow(
        "cursor",
      )
    } finally {
      await store.close()
    }
  }))

test("SQLite lexical upgrades preserve ready literal fragments until the ranked index is complete", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const options = storageTestOptions({
      namespace: `upgrade-${randomUUID()}`,
      filename: path.join(tmp.path, "agent.sqlite"),
    })
    if (options.backend !== "sqlite") return
    let store = await TransactionalStore.open(options)
    try {
      await store.write(key, { text: "original body" })
      const source = await store.versioned(key)
      const fragments = [
        { offset: 0, text: "架构 ownership" },
        { offset: 8192, text: "boundary untouched literal" },
      ]
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 0,
          fragments,
          complete: true,
        }),
      )
      await store.close()
      const driver = await SqliteDriver.open(options.filename)
      try {
        await driver.transaction(async (connection) => {
          await connection.query("DELETE FROM storage_text_terms WHERE namespace = ?", [options.namespace])
          await connection.query("DELETE FROM storage_text_lexical_sources WHERE namespace = ?", [options.namespace])
        })
      } finally {
        await driver.close()
      }
      store = await TransactionalStore.open(options)
      expect(
        (await store.snapshot((tx) => tx.searchTextProjection({ query: "untouched literal" }))).items,
      ).toHaveLength(1)
      expect(
        (await store.snapshot((tx) => tx.searchTextProjection({ query: "", terms: ["ownership"] }))).items,
      ).toEqual([])
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 0,
          fragments: [fragments[0]!],
          complete: false,
        }),
      )
      expect(
        (await store.snapshot((tx) => tx.searchTextProjection({ query: "untouched literal" }))).items,
      ).toHaveLength(1)
      expect(
        (await store.snapshot((tx) => tx.searchTextProjection({ query: "", terms: ["ownership"] }))).items,
      ).toEqual([])
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 1,
          fragments: [fragments[1]!],
          complete: true,
        }),
      )
      expect(
        (await store.snapshot((tx) => tx.searchTextProjection({ query: "", terms: ["ownership", "boundary"] }))).items,
      ).toHaveLength(1)
    } finally {
      await store.close()
    }
  }))

test("text projection publishes only complete current revisions and preserves literal Chinese search", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: `text-${randomUUID()}`, filename: path.join(tmp.path, "agent.sqlite") }),
    )
    try {
      await store.write(key, { text: "Original" })
      const source = await store.versioned(key)
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 0,
          fragments: [{ offset: 0, text: "前段 真实模型测试 OR * wildcard" }],
          complete: false,
        }),
      )
      expect(
        (
          await store.snapshot((tx) =>
            tx.searchTextProjection({ scopeID: "scope", sessionID: "session", query: "真实模型" }),
          )
        ).items,
      ).toEqual([])
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 1,
          fragments: [{ offset: 30, text: '后段 a"b ÉCOLE' }],
          complete: true,
        }),
      )
      const chinese = await store.snapshot((tx) =>
        tx.searchTextProjection({ scopeID: "scope", sessionID: "session", query: "真实模型" }),
      )
      expect(chinese.items[0]?.key).toEqual(key)
      expect(chinese.items[0]?.version).toBe("v1")
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: 'a"b' }))).items).toHaveLength(1)
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: "école" }))).items).toHaveLength(1)
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: "OR *" }))).items).toHaveLength(1)
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: "模型" }))).items).toHaveLength(1)
      await store.write(key, { text: "Changed" })
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: "真实模型" }))).items).toEqual([])
      expect(
        await store.transaction((tx) =>
          tx.appendTextProjection({
            key,
            revision: source.revision,
            version: "v1",
            category: "text",
            offset: 2,
            fragments: [],
            complete: true,
          }),
        ),
      ).toBe(false)
      const changed = await store.versioned(key)
      await expect(
        store.transaction(async (tx) => {
          await tx.appendTextProjection({
            key,
            revision: changed.revision,
            version: "v2",
            category: "text",
            offset: 0,
            fragments: [{ offset: 0, text: "Changed content" }],
            complete: true,
          })
          throw new Error("rollback")
        }),
      ).rejects.toThrow("rollback")
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: "Changed" }))).items).toEqual([])
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key,
          revision: changed.revision,
          version: "v2",
          category: "text",
          offset: 0,
          fragments: [{ offset: 0, text: "Changed content" }],
          complete: true,
        }),
      )
      await store.remove(key)
      expect((await store.snapshot((tx) => tx.searchTextProjection({ query: "Changed" }))).items).toEqual([])
      let removed = 0
      for (let batch = 0; batch < 10; batch++) {
        const result = await store.transaction((tx) => tx.collectTextProjection())
        expect(result.removed).toBeLessThanOrEqual(4)
        removed += result.removed
        if (result.ready) break
      }
      expect(removed).toBeGreaterThan(0)
      expect(await store.snapshot((tx) => tx.textProjectionState(key))).toBeUndefined()
    } finally {
      await store.close()
    }
  }))

test("short text queries scan bounded pages and recover all matches across cursors", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open(
      storageTestOptions({ namespace: `text-${randomUUID()}`, filename: path.join(tmp.path, "agent.sqlite") }),
    )
    try {
      for (let index = 0; index < 1100; index++) {
        const item = [...key.slice(0, -1), String(index)]
        await store.write(item, { text: "body" })
        const source = await store.versioned(item)
        await store.transaction((tx) =>
          tx.appendTextProjection({
            key: item,
            revision: source.revision,
            version: "v1",
            category: index % 2 ? "reasoning" : "text",
            offset: 0,
            fragments: [{ offset: 0, text: index === 1098 ? "末尾中文" : "其他文本" }],
            complete: true,
          }),
        )
      }
      let cursor: string | undefined
      const items: string[][] = []
      do {
        const page = await store.snapshot((tx) => tx.searchTextProjection({ query: "中文", cursor }))
        expect(page.scanned).toBeLessThanOrEqual(32)
        items.push(...page.items.map((item) => item.key))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      expect(items).toEqual([[...key.slice(0, -1), "1098"]])
      const mixed = await store.snapshot((tx) => tx.searchTextProjection({ query: "", terms: ["中文", "unmatched"] }))
      expect(mixed.items.map((item) => item.key)).toEqual(items)
      expect(mixed.scanned).toBe(1)
      expect(
        (
          await store.snapshot((tx) => tx.searchTextProjection({ query: "其他文本", categories: ["reasoning"] }))
        ).items.every((item) => Number(item.key.at(-1)) % 2 === 1),
      ).toBe(true)
    } finally {
      await store.close()
    }
  }))
