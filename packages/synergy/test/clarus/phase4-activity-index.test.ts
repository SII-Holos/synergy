import { beforeEach, describe, expect, test } from "bun:test"
import { isolateClarusHome } from "../helpers/clarus-isolation"
await isolateClarusHome(import.meta.url)

import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ClarusProjectActivityStore } from "../../src/clarus/activity"
import type { ClarusProjectActivity } from "../../src/clarus/schemas"

let AGENT_ID = "agent_ai"
let AGENT_ID_B = "agent_aib"
let PROJECT_ID = "project_ai"
let PROJECT_ID_B = "project_aib"

beforeEach(() => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  AGENT_ID = `agai_${suffix}`
  AGENT_ID_B = `agaib_${suffix}`
  PROJECT_ID = `pjai_${suffix}`
  PROJECT_ID_B = `pjaib_${suffix}`
})

function makeActivity(
  agentId: string,
  projectId: string,
  messageId: string,
  receivedAt: number,
  content?: string,
): ClarusProjectActivity {
  return {
    agentId,
    projectId,
    messageId,
    senderType: "user",
    content: content ?? `msg_${messageId}`,
    receivedAt,
  }
}

const ACTIVITY_TS_PAD = 16
const ACTIVITY_SORT_SEP = "--"

function buildSortKey(receivedAt: number, messageId: string): string {
  return `${String(receivedAt).padStart(ACTIVITY_TS_PAD, "0")}${ACTIVITY_SORT_SEP}${encodeURIComponent(messageId)}`
}

// ─────────────────────────────────────────────────────────────────
// 1. Timeline index writes
// ─────────────────────────────────────────────────────────────────
describe("timeline index writes", () => {
  test("upsert writes canonical record and timeline index entry", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const now = Date.now()
        const activity = makeActivity(AGENT_ID, PROJECT_ID, "msg_1", now)
        await ClarusProjectActivityStore.upsert(activity)

        const canonical = await ClarusProjectActivityStore.get(AGENT_ID, PROJECT_ID, "msg_1")
        expect(canonical).toBeDefined()
        expect(canonical!.messageId).toBe("msg_1")

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const timelineKeys = await Storage.scan(timelinePrefix)
        expect(timelineKeys.length).toBe(1)
        expect(timelineKeys[0]).toBe(buildSortKey(now, "msg_1"))

        const indexEntry = await Storage.read<{ messageId: string }>([...timelinePrefix, timelineKeys[0]])
        expect(indexEntry).toBeDefined()
        expect(indexEntry!.messageId).toBe("msg_1")
      },
    })
  })

  test("upsert on same messageId cleans up stale index entries and rewrites", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const t1 = 1000
        const t2 = 2000

        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", t1))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", t2, "updated"))

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const timelineKeys = await Storage.scan(timelinePrefix)

        expect(timelineKeys.length).toBe(1)
        expect(timelineKeys[0]).toBe(buildSortKey(t2, "msg_1"))

        const canonical = await ClarusProjectActivityStore.get(AGENT_ID, PROJECT_ID, "msg_1")
        expect(canonical!.content).toBe("updated")
      },
    })
  })

  test("upsert on same messageId with same receivedAt is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const now = Date.now()
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", now))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", now, "v2"))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", now, "v3"))

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const timelineKeys = await Storage.scan(timelinePrefix)
        expect(timelineKeys.length).toBe(1)

        const canonical = await ClarusProjectActivityStore.get(AGENT_ID, PROJECT_ID, "msg_1")
        expect(canonical!.content).toBe("v3")
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 2. Chronological pagination
// ─────────────────────────────────────────────────────────────────
describe("chronological pagination", () => {
  test("returns empty page when no activities exist", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items).toEqual([])
        expect(page.nextCursor).toBeNull()
      },
    })
  })

  test("returns items in ascending chronological order", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_3", 3000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(3)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_1", "msg_2", "msg_3"])
        expect(page.items[0].receivedAt).toBeLessThan(page.items[1].receivedAt)
        expect(page.items[1].receivedAt).toBeLessThan(page.items[2].receivedAt)
        expect(page.nextCursor).toBeNull()
      },
    })
  })

  test("equal timestamps use messageId as deterministic tie-breaker", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const ts = Date.now()
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_c", ts))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_a", ts))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_b", ts))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(3)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_a", "msg_b", "msg_c"])
      },
    })
  })

  test("pages correctly across multiple pages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const baseTs = 1000
        const count = 25
        for (let i = 0; i < count; i++) {
          await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, `msg_${i}`, baseTs + i * 100))
        }

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        expect(page1.items.length).toBe(10)
        expect(page1.items[0].messageId).toBe("msg_0")
        expect(page1.items[9].messageId).toBe("msg_9")
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page1.nextCursor!,
        })
        expect(page2.items.length).toBe(10)
        expect(page2.items[0].messageId).toBe("msg_10")
        expect(page2.items[9].messageId).toBe("msg_19")
        expect(page2.nextCursor).not.toBeNull()

        const page3 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page2.nextCursor!,
        })
        expect(page3.items.length).toBe(5)
        expect(page3.items[0].messageId).toBe("msg_20")
        expect(page3.items[4].messageId).toBe("msg_24")
        expect(page3.nextCursor).toBeNull()
      },
    })
  })

  test("later insertion after cursor appears on next page", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000))

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 1 })
        expect(page1.items.length).toBe(1)
        expect(page1.items[0].messageId).toBe("msg_1")

        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_3", 3000))

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page1.nextCursor!,
        })
        expect(page2.items.length).toBe(2)
        expect(page2.items[0].messageId).toBe("msg_2")
        expect(page2.items[1].messageId).toBe("msg_3")
      },
    })
  })

  test("forward-only cursor does not show earlier backfills", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_4", 4000))

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 1 })
        expect(page1.items[0].messageId).toBe("msg_2")
        expect(page1.nextCursor).not.toBeNull()

        // Backfill an earlier item
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))

        // Same cursor — msg_1 not visible (before cursor), msg_4 still visible
        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page1.nextCursor!,
        })
        expect(page2.items.length).toBe(1)
        expect(page2.items[0].messageId).toBe("msg_4")

        // Fresh page from start DOES include the backfill
        const freshPage = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        expect(freshPage.items.length).toBe(3)
        expect(freshPage.items.map((a) => a.messageId)).toEqual(["msg_1", "msg_2", "msg_4"])
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 3. Corrupt and missing entries
// ─────────────────────────────────────────────────────────────────
describe("corrupt and missing entries", () => {
  test("skips index entries with missing canonical records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const ghostSortKey = buildSortKey(500, "ghost_msg")
        await Storage.write([...timelinePrefix, ghostSortKey], { messageId: "ghost_msg" })

        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(2)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_1", "msg_2"])
      },
    })
  })

  test("skips corrupt sort keys (unparseable)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        await Storage.write([...timelinePrefix, "not-a-valid-key"], { messageId: "bad" })

        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(2)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_1", "msg_2"])
      },
    })
  })

  test("skips index entries with unparseable messageId", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const badSortKey = buildSortKey(500, "nonexistent_msg")
        await Storage.write([...timelinePrefix, badSortKey], { messageId: "nonexistent_msg" })

        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(2)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_1", "msg_2"])
      },
    })
  })

  test("all-corrupt index window advances cursor (does not dead-end)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        // 50 corrupt entries — with limit=10, scan window is 20 keys < 50 total.
        for (let i = 0; i < 50; i++) {
          await Storage.write([...timelinePrefix, `corrupt_${i}`], { messageId: `bad_${i}` })
        }

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        expect(page.items).toEqual([])
        // Cursor must advance so caller can continue past the corrupt window.
        expect(page.nextCursor).not.toBeNull()
        expect(page.nextCursor).toMatch(/^corrupt_/)
      },
    })
  })

  test("paginates through >limit*2 ghost entries to reach valid records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        // 50 ghost entries (index without canonical), then 3 valid records.
        const baseTs = 1000
        for (let i = 0; i < 50; i++) {
          const ghostKey = buildSortKey(baseTs + i, `ghost_${i}`)
          await Storage.write([...timelinePrefix, ghostKey], { messageId: `ghost_${i}` })
        }
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "real_a", baseTs + 50))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "real_b", baseTs + 51))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "real_c", baseTs + 52))

        // With limit=5, scan window is 10. First page scans 0-9 (all ghosts),
        // second page scans 10-19 (all ghosts), ... eventually reaches real records.
        let page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 5 })
        const allReal: string[] = []
        let pages = 0

        while (pages < 20) {
          pages++
          for (const item of page.items) allReal.push(item.messageId)
          if (!page.nextCursor) break
          page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
            limit: 5,
            cursor: page.nextCursor,
          })
        }

        expect(allReal).toContain("real_a")
        expect(allReal).toContain("real_b")
        expect(allReal).toContain("real_c")
        // Must have needed multiple pages to get past ghosts.
        expect(pages).toBeGreaterThan(1)
      },
    })
  })

  test("all-corrupt final window terminates after cursor progress", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        // 25 corrupt entries, limit=10, scan window=20. First page: 0-19 scanned.
        // Second page: last 5 scanned, then cursor becomes null.
        for (let i = 0; i < 25; i++) {
          await Storage.write([...timelinePrefix, `corrupt_${String(i).padStart(3, "0")}`], {
            messageId: `bad_${i}`,
          })
        }

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 10 })
        expect(page1.items).toEqual([])
        expect(page1.nextCursor).not.toBeNull()

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 10,
          cursor: page1.nextCursor!,
        })
        expect(page2.items).toEqual([])
        // Second page scanned the remaining 5 keys (all corrupt); none left.
        expect(page2.nextCursor).toBeNull()
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 4. Isolation
// ─────────────────────────────────────────────────────────────────
describe("isolation", () => {
  test("timeline index is scoped to one agent/project", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID_B, PROJECT_ID, "msg_2", 2000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID_B, "msg_3", 3000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(1)
        expect(page.items[0].messageId).toBe("msg_1")

        const pageB = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID_B, PROJECT_ID, { limit: 20 })
        expect(pageB.items.length).toBe(1)
        expect(pageB.items[0].messageId).toBe("msg_2")
      },
    })
  })

  test("scan scope is limited to one timeline index directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 5; i++) {
          await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, `msg_p1_${i}`, 1000 + i * 100))
          await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID_B, `msg_p2_${i}`, 2000 + i * 100))
        }

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page1.items.length).toBe(5)
        for (const item of page1.items) {
          expect(item.projectId).toBe(PROJECT_ID)
        }

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID_B, { limit: 20 })
        expect(page2.items.length).toBe(5)
        for (const item of page2.items) {
          expect(item.projectId).toBe(PROJECT_ID_B)
        }
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 5. Bounds
// ─────────────────────────────────────────────────────────────────
describe("bounds", () => {
  test("respects limit (max 100)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        for (let i = 0; i < 150; i++) {
          await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, `msg_${i}`, i * 100))
        }

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 200 })
        expect(page.items.length).toBeLessThanOrEqual(100)
      },
    })
  })

  test("respects minimum limit of 1", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 0 })
        expect(page.items.length).toBe(1)
      },
    })
  })

  test("scan budget bounds reads even with many corrupt entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        for (let i = 0; i < 5; i++) {
          const ghostSortKey = buildSortKey(i * 10, `ghost_early_${i}`)
          await Storage.write([...timelinePrefix, ghostSortKey], { messageId: `ghost_early_${i}` })
        }
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_good", 1000))
        for (let i = 0; i < 200; i++) {
          const ghostSortKey = buildSortKey(2000 + i * 10, `ghost_late_${i}`)
          await Storage.write([...timelinePrefix, ghostSortKey], { messageId: `ghost_late_${i}` })
        }

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 5 })
        expect(page.items.length).toBeGreaterThanOrEqual(1)
        expect(page.items.some((a) => a.messageId === "msg_good")).toBe(true)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 6. Migration
// ─────────────────────────────────────────────────────────────────
describe("migration", () => {
  test("migration builds index from existing canonical records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const records: ClarusProjectActivity[] = [
          makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000),
          makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000),
          makeActivity(AGENT_ID, PROJECT_ID, "msg_3", 3000),
        ]
        for (const record of records) {
          await Storage.write(
            StoragePath.clarusProjectActivity(record.agentId, record.projectId, record.messageId),
            record,
          )
        }

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const beforeKeys = await Storage.scan(timelinePrefix)
        expect(beforeKeys.length).toBe(0)

        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")
        const result = await migrateActivityTimelineIndex()
        expect(result.indexed).toBe(3)
        expect(result.malformed).toBe(0)

        const afterKeys = await Storage.scan(timelinePrefix)
        expect(afterKeys.length).toBe(3)
        expect(afterKeys[0]).toBe(buildSortKey(1000, "msg_1"))
        expect(afterKeys[1]).toBe(buildSortKey(2000, "msg_2"))
        expect(afterKeys[2]).toBe(buildSortKey(3000, "msg_3"))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(3)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_1", "msg_2", "msg_3"])
      },
    })
  })

  test("migration is idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_1"),
          makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000),
        )
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_2"),
          makeActivity(AGENT_ID, PROJECT_ID, "msg_2", 2000),
        )

        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")

        const result1 = await migrateActivityTimelineIndex()
        expect(result1.indexed).toBeGreaterThanOrEqual(2)

        const result2 = await migrateActivityTimelineIndex()
        expect(result2.indexed).toBe(0)
        expect(result2.skipped).toBeGreaterThanOrEqual(2)

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const keys = await Storage.scan(timelinePrefix)
        expect(keys).toContain(buildSortKey(1000, "msg_1"))
        expect(keys).toContain(buildSortKey(2000, "msg_2"))
      },
    })
  })

  test("migration preserves malformed canonical records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_1"),
          makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000),
        )
        await Storage.write(StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_bad"), { notAnActivity: true })
        await Storage.write(StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_null"), null)

        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")
        const result = await migrateActivityTimelineIndex()
        expect(result.indexed).toBe(1)
        expect(result.malformed).toBe(2)

        const badStill = await Storage.read<unknown>(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_bad"),
        ).catch(() => undefined)
        expect(badStill).toBeDefined()

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const keys = await Storage.scan(timelinePrefix)
        expect(keys.length).toBe(1)
        expect(keys[0]).toBe(buildSortKey(1000, "msg_1"))
      },
    })
  })

  test("migration handles empty activity directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")
        const result = await migrateActivityTimelineIndex()
        expect(result.indexed).toBe(0)
      },
    })
  })

  test("migration handles multiple agents and projects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "msg_a1"),
          makeActivity(AGENT_ID, PROJECT_ID, "msg_a1", 1000),
        )
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID_B, PROJECT_ID, "msg_b1"),
          makeActivity(AGENT_ID_B, PROJECT_ID, "msg_b1", 2000),
        )

        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")
        const result = await migrateActivityTimelineIndex()
        expect(result.indexed).toBe(2)

        const keysA = await Storage.scan(StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID))
        const keysB = await Storage.scan(StoragePath.clarusActivityTimelineIndex(AGENT_ID_B, PROJECT_ID))
        expect(keysA.length).toBe(1)
        expect(keysB.length).toBe(1)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 7. Recovery
// ─────────────────────────────────────────────────────────────────
describe("recovery", () => {
  test("canonical without index is recoverable via migration", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "orphan"),
          makeActivity(AGENT_ID, PROJECT_ID, "orphan", 5000),
        )

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page1.items).toEqual([])

        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")
        await migrateActivityTimelineIndex()

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page2.items.length).toBe(1)
        expect(page2.items[0].messageId).toBe("orphan")
      },
    })
  })

  test("upsert after migration keeps timeline consistent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "migrated"),
          makeActivity(AGENT_ID, PROJECT_ID, "migrated", 1000),
        )

        const { migrateActivityTimelineIndex } = await import("../../src/clarus/migration")
        await migrateActivityTimelineIndex()

        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "new_1", 2000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "new_2", 3000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page.items.length).toBe(3)
        expect(page.items.map((a) => a.messageId)).toEqual(["migrated", "new_1", "new_2"])
      },
    })
  })

  test("bounded repair recovers canonical-without-index crash state within page calls", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Simulate crash after stale-index removal but before new index write:
        // write canonical only, no index entry.
        await Storage.write(
          StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, "orphan"),
          makeActivity(AGENT_ID, PROJECT_ID, "orphan", 5000),
        )
        // Also add a valid indexed entry for context.
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "intact", 1000))

        // First page: bounded repair should find and repair the orphan.
        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        expect(page1.items.length).toBeGreaterThanOrEqual(1)
        const ids = page1.items.map((a) => a.messageId)
        expect(ids).toContain("intact")
        // The orphan should have been repaired and is now visible on a fresh page.
        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        const allIds = page2.items.map((a) => a.messageId)
        expect(allIds).toContain("orphan")
      },
    })
  })

  test("repair budget never becomes unbounded with many orphans", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Create 15 orphan canonicals (no index entries).
        const totalOrphans = 15
        for (let i = 0; i < totalOrphans; i++) {
          await Storage.write(
            StoragePath.clarusProjectActivity(AGENT_ID, PROJECT_ID, `orphan_${i}`),
            makeActivity(AGENT_ID, PROJECT_ID, `orphan_${i}`, 1000 + i * 100),
          )
        }

        // With REPAIR_BUDGET=5, first call repairs at most 5.
        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        const count1 = page1.items.filter((a) => a.messageId.startsWith("orphan_")).length
        expect(count1).toBeLessThanOrEqual(5)

        // Repeated calls progressively repair more.
        let totalSeen = count1
        for (let round = 0; round < 5 && totalSeen < totalOrphans; round++) {
          const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
          const orphanCount = page.items.filter((a) => a.messageId.startsWith("orphan_")).length
          totalSeen = Math.max(totalSeen, orphanCount)
        }

        // Eventually all should be repaired.
        const finalPage = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 50 })
        const finalOrphanCount = finalPage.items.filter((a) => a.messageId.startsWith("orphan_")).length
        expect(finalOrphanCount).toBe(totalOrphans)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 8. Cursor format
// ─────────────────────────────────────────────────────────────────
describe("cursor format", () => {
  test("cursor is opaque sortKey and resumes correctly", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const now = Date.now()
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", now))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_2", now + 100))

        const page1 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 1 })
        expect(page1.nextCursor).toBe(buildSortKey(now, "msg_1"))

        const page2 = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 1,
          cursor: page1.nextCursor!,
        })
        expect(page2.items[0].messageId).toBe("msg_2")
        expect(page2.nextCursor).toBeNull()
      },
    })
  })

  test("unknown cursor returns from beginning", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_1", 1000))

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
          limit: 20,
          cursor: "nonexistent-cursor",
        })
        expect(page.items.length).toBe(1)
        expect(page.items[0].messageId).toBe("msg_1")
      },
    })
  })

  test("cursor never repeats across pages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const baseTs = 1000
        for (let i = 0; i < 30; i++) {
          await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, `msg_${i}`, baseTs + i * 100))
        }

        const cursors: (string | null)[] = []
        let cursor: string | null = null
        for (let round = 0; round < 10; round++) {
          const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
            limit: 3,
            cursor: cursor ?? undefined,
          })
          cursor = page.nextCursor
          cursors.push(cursor)
          if (!cursor) break
        }

        // All cursors should be distinct (no repeats).
        const nonNullCursors = cursors.filter((c): c is string => c !== null)
        expect(new Set(nonNullCursors).size).toBe(nonNullCursors.length)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 9. Concurrent upsert safety (advisory lock)
// ─────────────────────────────────────────────────────────────────
describe("concurrent upsert safety", () => {
  test("concurrent upserts on same messageId yield exactly one index entry", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const baseTs = 1000
        const count = 50
        const promises: Promise<ClarusProjectActivity>[] = []
        for (let i = 0; i < count; i++) {
          promises.push(
            ClarusProjectActivityStore.upsert(
              makeActivity(AGENT_ID, PROJECT_ID, "msg_shared", baseTs + i, `content_v${i}`),
            ),
          )
        }
        await Promise.all(promises)

        // Exactly one index entry for this messageId.
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const timelineKeys = await Storage.scan(timelinePrefix)
        expect(timelineKeys.length).toBe(1)

        // Canonical and index agree on content.
        const canonical = await ClarusProjectActivityStore.get(AGENT_ID, PROJECT_ID, "msg_shared")
        expect(canonical).toBeDefined()
        // Content should be the last written version (highest receivedAt).
        expect(canonical!.content).toBe(`content_v${count - 1}`)
        // receivedAt should match what the final upsert wrote.
        expect(canonical!.receivedAt).toBe(baseTs + count - 1)
      },
    })
  })

  test("different messageIds remain concurrently writable", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const count = 20
        const promises: Promise<ClarusProjectActivity>[] = []
        for (let i = 0; i < count; i++) {
          promises.push(ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, `msg_${i}`, 1000 + i)))
        }
        await Promise.all(promises)

        // All 20 messageIds should each have one index entry.
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        const timelineKeys = await Storage.scan(timelinePrefix)
        expect(timelineKeys.length).toBe(count)

        // All canonicals should be readable.
        for (let i = 0; i < count; i++) {
          const canonical = await ClarusProjectActivityStore.get(AGENT_ID, PROJECT_ID, `msg_${i}`)
          expect(canonical).toBeDefined()
          expect(canonical!.messageId).toBe(`msg_${i}`)
        }
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// 10. Deduplication
// ─────────────────────────────────────────────────────────────────
describe("deduplication", () => {
  test("historical duplicate index entries deduplicated in page output", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Write one canonical.
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "dup", 2000, "the_content"))

        // Manually inject duplicate index entries for the same messageId.
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        await Storage.write([...timelinePrefix, buildSortKey(1500, "dup")], { messageId: "dup" })
        await Storage.write([...timelinePrefix, buildSortKey(2500, "dup")], { messageId: "dup" })

        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 20 })
        // "dup" should appear exactly once.
        const dupItems = page.items.filter((a) => a.messageId === "dup")
        expect(dupItems.length).toBe(1)
        expect(dupItems[0].content).toBe("the_content")
      },
    })
  })

  test("dedup prevents duplicates within a single page", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        // Write 3 valid canonicals.
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_a", 1000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_b", 2000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_c", 3000))

        // Inject duplicate index entries for msg_b at different sort positions.
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        await Storage.write([...timelinePrefix, buildSortKey(1900, "msg_b")], { messageId: "msg_b" })
        await Storage.write([...timelinePrefix, buildSortKey(2100, "msg_b")], { messageId: "msg_b" })

        // With limit=5, all 5 index entries fit in one scan window.
        // msg_b should appear exactly once in the page (deduped within page).
        const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, { limit: 5 })
        const msgBItems = page.items.filter((a) => a.messageId === "msg_b")
        expect(msgBItems.length).toBe(1)
        expect(page.items.map((a) => a.messageId)).toEqual(["msg_a", "msg_b", "msg_c"])
      },
    })
  })

  test("cursor progresses through duplicate index positions", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_a", 1000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_b", 2000))
        await ClarusProjectActivityStore.upsert(makeActivity(AGENT_ID, PROJECT_ID, "msg_c", 3000))

        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(AGENT_ID, PROJECT_ID)
        await Storage.write([...timelinePrefix, buildSortKey(1900, "msg_b")], { messageId: "msg_b" })
        await Storage.write([...timelinePrefix, buildSortKey(2100, "msg_b")], { messageId: "msg_b" })

        // With limit=1, each page shows one entry. The cursor still advances
        // through all index keys including duplicate positions.
        const allSeen: string[] = []
        const allCursors: (string | null)[] = []
        let cursor: string | null = null
        for (let round = 0; round < 10; round++) {
          const page = await ClarusProjectActivityStore.listByProjectPaginated(AGENT_ID, PROJECT_ID, {
            limit: 1,
            cursor: cursor ?? undefined,
          })
          for (const item of page.items) allSeen.push(item.messageId)
          allCursors.push(cursor)
          cursor = page.nextCursor
          if (!cursor) break
        }

        // All three unique messages are eventually seen.
        expect(new Set(allSeen)).toEqual(new Set(["msg_a", "msg_b", "msg_c"]))
        // No null cursor repeated (cursor always advances).
        const nonNullCursors = allCursors.filter((c): c is string => c !== null)
        expect(new Set(nonNullCursors).size).toBe(nonNullCursors.length)
      },
    })
  })
})
