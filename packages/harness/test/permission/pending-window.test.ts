import { expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

test("native pending permission windows stay bounded and continue after the cursor request is resolved", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const controller = new AbortController()
        const pending: Promise<unknown>[] = []
        try {
          for (let index = 0; index < 65; index++) {
            const id = `permission-window-${String(index).padStart(4, "0")}`
            const asked = Promise.withResolvers<void>()
            const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
              if (properties.id === id) asked.resolve()
            })
            pending.push(
              PermissionNext.ask({
                id,
                sessionID: "session-window",
                permission: "bash",
                patterns: ["fixture *"],
                ruleset: [],
                metadata: {},
                signal: controller.signal,
              }).catch((error: unknown) => error),
            )
            try {
              await asked.promise
            } finally {
              unsubscribe()
            }
          }
          const first = await PermissionNext.pendingPage({ sessionID: "session-window", limit: 17 })
          expect(first.items).toHaveLength(17)
          expect(first.hasMore).toBeTrue()
          const last = first.items.at(-1)!
          await PermissionNext.reply({ requestID: last.info.id, reply: "once" })
          const second = await PermissionNext.pendingPage({
            sessionID: "session-window",
            limit: 17,
            after: last.ordinal,
            viewID: first.viewID,
          })
          expect(second.items).toHaveLength(17)
          expect(second.items[0]?.info.id).toBe("permission-window-0017")
          expect(second.items.every((item) => item.ordinal > last.ordinal)).toBeTrue()
          expect((await PermissionNext.pendingPage({ sessionID: "session-other", limit: 17 })).items).toEqual([])
          await expect(
            PermissionNext.pendingPage({
              sessionID: "session-window",
              limit: 17,
              after: last.ordinal,
              viewID: "stale-native-view",
            }),
          ).rejects.toThrow("view changed")
        } finally {
          controller.abort()
          await Promise.allSettled(pending)
        }
      },
    }),
  )
})

test("native pending windows preserve admission order independently of lexical request ordering", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const controller = new AbortController()
        const pending: Promise<unknown>[] = []
        try {
          for (const id of ["per9", "per2", "per10"]) {
            const asked = Promise.withResolvers<void>()
            const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, ({ properties }) => {
              if (properties.id === id) asked.resolve()
            })
            pending.push(
              PermissionNext.ask({
                id,
                sessionID: "session-native-order",
                permission: "bash",
                patterns: ["fixture *"],
                ruleset: [],
                metadata: {},
                signal: controller.signal,
              }).catch((error: unknown) => error),
            )
            try {
              await asked.promise
            } finally {
              unsubscribe()
            }
          }
          let after: number | undefined
          let viewID: string | undefined
          for (const id of ["per9", "per2", "per10"]) {
            const page = await PermissionNext.pendingPage({
              sessionID: "session-native-order",
              limit: 1,
              after,
              viewID,
            })
            expect(page.items.map((item) => item.info.id)).toEqual([id])
            expect(page.hasMore).toBe(id !== "per10")
            after = page.items[0]!.ordinal
            viewID = page.viewID
          }
        } finally {
          controller.abort()
          await Promise.allSettled(pending)
        }
      },
    }),
  )
})
