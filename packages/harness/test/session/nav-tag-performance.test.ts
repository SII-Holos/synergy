import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { SessionNav } from "../../src/session/nav"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
describe("SessionNav tag performance", () => {
  test("measures tag query performance with large navigation indexes", async () => {
    const sizes = [100, 500, 1000, 5000]

    const results: Array<{
      size: number
      matched: number
      averageMs: number
      maxMs: number
    }> = []

    for (const size of sizes) {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const now = Date.now()

          const entries = Array.from({ length: size }, (_, i) => ({
            id: `performance-session-${i}`,
            scopeID: scope.id,
            scopeType: "project" as const,
            title: `Performance Session ${i}`,
            tags: i % 3 === 0 ? ["performance"] : ["other"],
            category: "session" as const,
            lastActivityAt: now - i,
            createdAt: now - i,
            updatedAt: now - i,
            pinned: 0,
            archived: false,
            completionNotice: {
              unread: false,
              unreadCount: 0,
            },
          }))

          await Storage.write(StoragePath.sessionNavIndex(Identifier.asScopeID(scope.id)), {
            version: 1,
            scopeID: scope.id,
            updatedAt: now,
            entries,
          })

          // Warm up
          await SessionNav.queryScope(scope.id, {
            tag: "performance",
            limit: 20,
          })

          const times: number[] = []
          let result

          for (let i = 0; i < 100; i++) {
            const start = performance.now()

            result = await SessionNav.queryScope(scope.id, {
              tag: "performance",
              limit: 20,
            })

            times.push(performance.now() - start)
          }

          const averageMs = times.reduce((sum, value) => sum + value, 0) / times.length

          const maxMs = Math.max(...times)

          expect(result).toBeDefined()
          expect(result!.items.every((item) => item.tags?.includes("performance"))).toBe(true)

          results.push({
            size,
            matched: result!.total,
            averageMs,
            maxMs,
          })
        },
      })
    }

    console.log("\n=== Session Tag Query Performance ===")

    for (const result of results) {
      console.log(
        `${result.size.toString().padStart(5)} sessions | ` +
          `${result.matched.toString().padStart(5)} matched | ` +
          `avg: ${result.averageMs.toFixed(3)} ms | ` +
          `max: ${result.maxMs.toFixed(3)} ms`,
      )
    }
  })
})
