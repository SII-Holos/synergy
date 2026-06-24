import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { SessionInvoke } from "../../src/session/invoke"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("cancel - clears all pending PermissionNext entries for the cancelled session", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "cancel-cleanup-test" })
      const sessionID = session.id

      const p1 = PermissionNext.ask({
        id: "perm_cancel_1",
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).catch(() => {})

      const p2 = PermissionNext.ask({
        id: "perm_cancel_2",
        sessionID,
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
      }).catch(() => {})

      const before = await PermissionNext.list()
      const oursBefore = before.filter((r) => r.sessionID === sessionID)
      expect(oursBefore.length).toBe(2)

      SessionInvoke.cancel(sessionID)
      await new Promise((r) => setTimeout(r, 50))

      const after = await PermissionNext.list()
      const oursAfter = after.filter((r) => r.sessionID === sessionID)

      expect(oursAfter.length).toBe(0)

      for (const entry of oursAfter) {
        await PermissionNext.reply({ requestID: entry.id, reply: "once" })
      }
      p1.catch(() => {})
      p2.catch(() => {})
    },
  })
})

test("cancel - rejects pending promises when session is cancelled", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "cancel-reject" })
      const sessionID = session.id

      let outcome: "resolved" | "rejected" | "aborted" | "timeout" = "timeout"

      const promise = PermissionNext.ask({
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
        .then(() => {
          outcome = "resolved"
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") {
            outcome = "aborted"
          } else {
            outcome = "rejected"
          }
        })

      SessionInvoke.cancel(sessionID)

      await Promise.race([promise, new Promise<void>((r) => setTimeout(r, 500))])

      if (outcome === "timeout") {
        const pending = await PermissionNext.list()
        const leftover = pending.find((r) => r.sessionID === sessionID)
        if (leftover) {
          await PermissionNext.reply({ requestID: leftover.id, reply: "once" })
        }
        promise.catch(() => {})
      }

      expect(outcome).not.toBe("timeout")
    },
  })
})

test("cancel - reply on cancelled session request ID is no-op", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "cancel-reply-noop" })
      const sessionID = session.id

      const p = PermissionNext.ask({
        id: "perm_cancel_noop",
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).catch(() => {})

      SessionInvoke.cancel(sessionID)
      await new Promise((r) => setTimeout(r, 50))

      await PermissionNext.reply({ requestID: "perm_cancel_noop", reply: "once" })

      const pending = await PermissionNext.list()
      const leftover = pending.find((r) => r.id === "perm_cancel_noop")
      expect(leftover).toBeUndefined()

      p.catch(() => {})
    },
  })
})

test("cancel - only clears entries for the targeted session", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const sessionA = await Session.create({ title: "cancel-scope-A" })
      const sessionB = await Session.create({ title: "cancel-scope-B" })

      PermissionNext.ask({
        id: "perm_scope_a",
        sessionID: sessionA.id,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).catch(() => {})

      PermissionNext.ask({
        id: "perm_scope_b",
        sessionID: sessionB.id,
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
      }).catch(() => {})

      SessionInvoke.cancel(sessionA.id)
      await new Promise((r) => setTimeout(r, 50))

      const pending = await PermissionNext.list()

      const aLeftover = pending.filter((r) => r.sessionID === sessionA.id)
      expect(aLeftover.length).toBe(0)

      const bLeftover = pending.filter((r) => r.sessionID === sessionB.id)
      expect(bLeftover.length).toBe(1)

      for (const entry of aLeftover) {
        await PermissionNext.reply({ requestID: entry.id, reply: "once" })
      }
      for (const entry of bLeftover) {
        await PermissionNext.reply({ requestID: entry.id, reply: "once" })
      }
    },
  })
})
