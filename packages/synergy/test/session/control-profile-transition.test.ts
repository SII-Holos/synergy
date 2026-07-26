import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { BusyError } from "../../src/session/error"
import { PermissionNext } from "../../src/permission/next"

describe("control-profile transition (issue #903)", () => {
  test("updateControlProfile remains busy-blocked (idle-only regression)", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        try {
          // Acquire a lease to simulate a busy session
          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()

          // updateControlProfile must reject when busy
          await expect(Session.updateControlProfile(session.id, "full_access")).rejects.toBeInstanceOf(BusyError)

          // Release the lease
          await SessionManager.release(lease!, { requestNextWork: false })

          // After release, updateControlProfile should succeed
          const updated = await Session.updateControlProfile(session.id, "full_access")
          expect(updated.controlProfile).toBe("full_access")
        } finally {
          // Cleanup: release any remaining lease
          const runtime = SessionManager.getRuntime(session.id)
          if (runtime?.owner) {
            await SessionManager.release(runtime.owner.lease, { requestNextWork: false })
          }
          await Session.remove(session.id)
        }
      },
    })
  })

  test("transitionControlProfileAndResolve transitions to full_access and drains pending permissions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })

        try {
          // Create pending permissions in parent and child
          const parentAsk = PermissionNext.ask({
            id: "perm_parent_drain",
            sessionID: parent.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            ruleset: [],
          })
          const childAsk = PermissionNext.ask({
            id: "perm_child_drain",
            sessionID: child.id,
            permission: "edit",
            patterns: ["foo.ts"],
            metadata: {},
            ruleset: [],
          })

          // Unrelated session with its own pending
          const unrelated = await Session.create({})
          const unrelatedAsk = PermissionNext.ask({
            id: "perm_unrelated_drain",
            sessionID: unrelated.id,
            permission: "bash",
            patterns: ["date"],
            metadata: {},
            ruleset: [],
          })

          // Transition parent to full_access — must be idle
          // The new method exists: Session.transitionControlProfileAndResolve
          const result = await Session.transitionControlProfileAndResolve(parent.id, "full_access")

          // Parent should now be full_access
          expect(result.controlProfile).toBe("full_access")

          // Both parent and child pending asks should be resolved
          await expect(parentAsk).resolves.toBeUndefined()
          await expect(childAsk).resolves.toBeUndefined()

          // Unrelated pending should still exist
          const pending = await PermissionNext.list()
          expect(pending.some((r) => r.id === "perm_unrelated_drain")).toBe(true)

          // Cleanup
          await PermissionNext.reply({ requestID: "perm_unrelated_drain", reply: "once" })
          await Session.remove(unrelated.id)
        } finally {
          await Session.remove(child.id)
          await Session.remove(parent.id)
        }
      },
    })
  })

  test("transitionControlProfileAndResolve persists profile before resolving", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        try {
          const askPromise = PermissionNext.ask({
            id: "perm_persist_order",
            sessionID: session.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            ruleset: [],
          })

          // Don't await — we want to verify the profile is persisted
          // before the ask resolves. We can observe this by reading
          // the session after transition returns but before checking
          // if the permission was resolved.
          const result = await Session.transitionControlProfileAndResolve(session.id, "full_access")

          // Profile should be full_access on the returned session object
          expect(result.controlProfile).toBe("full_access")

          // The stored session should also reflect full_access
          const reread = await Session.get(session.id)
          expect(reread.controlProfile).toBe("full_access")

          // Permission should be resolved
          await expect(askPromise).resolves.toBeUndefined()
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("transitionControlProfileAndResolve is busy-safe (succeeds while busy)", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        try {
          // Acquire a lease to simulate busy
          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()

          // transitionControlProfileAndResolve must succeed while busy
          const result = await Session.transitionControlProfileAndResolve(session.id, "full_access")
          expect(result.controlProfile).toBe("full_access")

          // Release
          await SessionManager.release(lease!, { requestNextWork: false })
        } finally {
          const runtime = SessionManager.getRuntime(session.id)
          if (runtime?.owner) {
            await SessionManager.release(runtime.owner.lease, { requestNextWork: false })
          }
          await Session.remove(session.id)
        }
      },
    })
  })

  test("descendant sessions that inherit profile are drained", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        // Grandchild: child inheriting from child (which inherits from parent)
        const grandchild = await Session.create({ parentID: child.id })

        try {
          // Create pending in parent and grandchild (child has none)
          const parentAsk = PermissionNext.ask({
            id: "perm_gparent_drain",
            sessionID: parent.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            ruleset: [],
          })
          const grandchildAsk = PermissionNext.ask({
            id: "perm_grandchild_drain",
            sessionID: grandchild.id,
            permission: "edit",
            patterns: ["bar.ts"],
            metadata: {},
            ruleset: [],
          })

          // Transition parent — should drain all descendants
          await Session.transitionControlProfileAndResolve(parent.id, "full_access")

          // All should be resolved
          await expect(parentAsk).resolves.toBeUndefined()
          await expect(grandchildAsk).resolves.toBeUndefined()
        } finally {
          await Session.remove(grandchild.id)
          await Session.remove(child.id)
          await Session.remove(parent.id)
        }
      },
    })
  })
  test("descendants with an explicit profile keep their pending permissions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await Session.updateControlProfile(child.id, "autonomous")

        try {
          const childAsk = PermissionNext.ask({
            id: "perm_explicit_child",
            sessionID: child.id,
            permission: "bash",
            patterns: ["date"],
            metadata: {},
            ruleset: [],
          })

          await Session.transitionControlProfileAndResolve(parent.id, "full_access")

          expect((await PermissionNext.list()).map((request) => request.id)).toContain("perm_explicit_child")
          await PermissionNext.reply({ requestID: "perm_explicit_child", reply: "once" })
          await expect(childAsk).resolves.toBeUndefined()
        } finally {
          await Session.remove(child.id)
          await Session.remove(parent.id)
        }
      },
    })
  })
})
