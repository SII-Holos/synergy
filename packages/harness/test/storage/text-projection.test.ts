import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestOptions } from "../support/storage-backends"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const key = ["sessions", "scope", "session", "messages", "message", "parts", "part"]

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
      for (let index = 0; index < 70; index++) {
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
            fragments: [{ offset: 0, text: index === 68 ? "末尾中文" : "其他文本" }],
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
      expect(items).toEqual([[...key.slice(0, -1), "68"]])
      expect(
        (
          await store.snapshot((tx) => tx.searchTextProjection({ query: "其他文本", categories: ["reasoning"] }))
        ).items.every((item) => Number(item.key.at(-1)) % 2 === 1),
      ).toBe(true)
    } finally {
      await store.close()
    }
  }))
