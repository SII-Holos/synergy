import { expect, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { FileMutation } from "../../src/file/mutation"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("Session turns serialize writes across files while reads and disjoint Workspaces proceed", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({}),
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: b.path } }),
      ],
    })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    const first = SessionManager.run(sessions[0]!.id, async () => {
      await FileMutation.write({ path: path.join(a.path, "one.txt"), content: "one", expectedVersion: null })
      order.push("first")
      started.resolve()
      await release.promise
      order.push("first-finished")
    })
    await started.promise
    const second = SessionManager.run(sessions[1]!.id, async () => {
      await FileMutation.write({ path: path.join(a.path, "two.txt"), content: "two", expectedVersion: null })
      order.push("second")
    })
    try {
      const content = await SessionManager.run(sessions[2]!.id, () =>
        FileMutation.readText(path.join(a.path, "one.txt")),
      )
      expect(content).toBe("one")
      await SessionManager.run(sessions[3]!.id, () =>
        FileMutation.write({ path: path.join(b.path, "other.txt"), content: "other", expectedVersion: null }),
      )
      expect(order).toEqual(["first"])
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }
    expect(order).toEqual(["first", "first-finished", "second"])
  })
}, 10_000)

test("a parent hands off its write reservation to a child in the same Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    const { parent, child } = await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        return { parent, child: await Session.create({ parentID: parent.id }) }
      },
    })
    const order: string[] = []
    await SessionManager.run(parent.id, async () => {
      await FileMutation.write({ path: path.join(tmp.path, "parent.txt"), content: "parent", expectedVersion: null })
      order.push("parent")
      await WorkspaceAccess.handoff(() =>
        SessionManager.run(child.id, async () => {
          await FileMutation.write({ path: path.join(tmp.path, "child.txt"), content: "child", expectedVersion: null })
          order.push("child")
        }),
      )
      await FileMutation.write({ path: path.join(tmp.path, "after.txt"), content: "after", expectedVersion: null })
      order.push("parent-resumed")
    })
    expect(order).toEqual(["parent", "child", "parent-resumed"])
  })
}, 10_000)

test("retirement can publish its own binding change without releasing native exclusion", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using directory = await tmpdir(),
      outside = await tmpdir()
    const { WorkspaceBinding } = await import("@ericsanchezok/synergy-harness/workspace")
    const scope = await directory.scope()
    const before = await WorkspaceBinding.register(scope.id, directory.path)
    await WorkspaceAccess.maintenance(async () => {
      await WorkspaceAccess.reserveWrite(null)
      await WorkspaceAccess.retire([directory.path], async () => {
        const after = await WorkspaceBinding.rebind(before.id, {
          scopeID: scope.id,
          expectedRevision: before.revision,
          path: directory.path,
        })
        expect(after.binding.generation).toBe(before.binding.generation + 1)
        let escaped = false
        await expect(
          WorkspaceAccess.exclusive([outside.path], async () => {
            escaped = true
          }),
        ).rejects.toThrow("retirement")
        expect(escaped).toBe(false)
      })
    })
  })
})

test("retirement writes reuse their native exclusion and reject late reservation expansion", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using directory = await tmpdir()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("Retirement fixture deadline")), 1000)
    try {
      await WorkspaceAccess.maintenance(
        () =>
          WorkspaceAccess.retire([directory.path], async () => {
            await FileMutation.write({
              path: path.join(directory.path, "owned.txt"),
              content: "owned",
              expectedVersion: null,
            })
            await expect(WorkspaceAccess.reserveWrite(null)).rejects.toThrow("before retirement")
            await expect(WorkspaceAccess.handoff(async () => {})).rejects.toThrow("retirement")
          }),
        { signal: controller.signal },
      )
      expect(await FileMutation.readText(path.join(directory.path, "owned.txt"))).toBe("owned")
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    await WorkspaceAccess.exclusive([directory.path], async () => {})
  })
})
