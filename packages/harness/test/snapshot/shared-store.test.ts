import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotLease } from "../../src/session/snapshot-lease"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

async function objects(repo: string) {
  const result = await SnapshotStore.command(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
  return result.split("\n").filter(Boolean).sort()
}

describe("shared snapshot storage", () => {
  test("excludes newly oversized literal paths while preserving files and historical objects", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const file = path.join(tmp.path, "literal[1].txt")
        await Bun.write(file, "before")
        await Bun.write(path.join(tmp.path, "literal1.txt"), "keep")
        const projectRepo = path.join(tmp.path, ".git")
        await SnapshotStore.command(projectRepo, ["add", "--all"])
        const projectIndex = await fs.readFile(path.join(projectRepo, "index"))
        const before = await Snapshot.track("session-size")
        expect(before).toBeTruthy()
        const oversized = "x".repeat(2 * 1024 * 1024 + 1)
        await Bun.write(file, oversized)
        const after = await Snapshot.track("session-size")
        expect(after).toBeTruthy()
        const repo = SnapshotStore.repository(scope.id)
        const files = (await SnapshotStore.command(repo, ["ls-tree", "-z", "--name-only", after!])).split("\0")
        expect(files).toContain("literal1.txt")
        expect(files).not.toContain("literal[1].txt")
        expect(await Bun.file(file).text()).toBe(oversized)
        expect(await SnapshotStore.command(repo, ["show", `${before}:literal[1].txt`])).toBe("before")
        expect(await fs.readFile(path.join(projectRepo, "index"))).toEqual(projectIndex)
      },
    })
  })

  test("cancellation while maintenance owns the store preserves empty snapshot results", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Bun.write(path.join(tmp.path, "file.txt"), "before")
        const hash = (await Snapshot.track("session-cancel"))!
        await SnapshotLease.use(scope.id, true, async () => {
          const controller = new AbortController()
          const capturing = Snapshot.track("session-cancel", controller.signal)
          const patching = Snapshot.patch(hash, "session-cancel", { signal: controller.signal })
          const diffing = Snapshot.diff(hash, "session-cancel", { signal: controller.signal })
          setTimeout(() => controller.abort(), 50)
          expect(await capturing).toBeUndefined()
          expect((await patching).files).toEqual([])
          expect(await diffing).toBe("")
        })
      },
    })
  })
  test("identical sessions reuse objects while retaining independent ownership", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Bun.write(path.join(tmp.path, "shared.txt"), "one stored copy")
        const first = await Snapshot.track("session-a")
        const initial = await objects(SnapshotStore.repository(scope.id))
        const second = await Snapshot.track("session-b")
        expect(second).toBe(first)
        expect(await objects(SnapshotStore.repository(scope.id))).toEqual(initial)
        expect(await SnapshotStore.owns(scope.id, "session-a", first!)).toBe(true)
        expect(await SnapshotStore.owns(scope.id, "session-b", second!)).toBe(true)
        await Bun.write(path.join(tmp.path, "shared.txt"), "changed")
        expect(await Snapshot.diff(first!, "unrelated-session")).toBe("")
        expect(await Snapshot.diff(first!, "session-b")).toContain("one stored copy")
      },
    })
  })

  test("concurrent sessions and distinct workspaces cannot overwrite each other's indexes", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const scope = await first.scope()
    await Bun.write(path.join(first.path, "a.txt"), "workspace A")
    await Bun.write(path.join(second.path, "b.txt"), "workspace B")
    const trees = await Promise.all([
      ScopeContext.provide({
        scope,
        workspace: { type: "main", path: first.path, scopeID: scope.id },
        fn: () => Snapshot.track("session-a"),
      }),
      ScopeContext.provide({
        scope,
        workspace: { type: "main", path: second.path, scopeID: scope.id },
        fn: () => Snapshot.track("session-b"),
      }),
    ])
    expect(trees.every(Boolean)).toBe(true)
    expect(trees[0]).not.toBe(trees[1])
    const repo = SnapshotStore.repository(scope.id)
    expect(await SnapshotStore.command(repo, ["ls-tree", "--name-only", trees[0]!])).toContain("a.txt")
    expect(await SnapshotStore.command(repo, ["ls-tree", "--name-only", trees[1]!])).not.toContain("a.txt")
  })

  test("tree roots keep all historical contents alive through garbage collection", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const file = path.join(tmp.path, "history.txt")
        await Bun.write(file, "before")
        const before = await Snapshot.track("session-a")
        await Bun.write(file, "after")
        const after = await Snapshot.track("session-a")
        const repo = SnapshotStore.repository(scope.id)
        await SnapshotStore.command(repo, ["gc", "--prune=now"])
        await SnapshotStore.command(repo, ["fsck", "--full"])
        await Snapshot.revert([{ hash: before!, files: [file] }], "session-a")
        expect(await fs.readFile(file, "utf8")).toBe("before")
        await Snapshot.revert([{ hash: after!, files: [file] }], "session-a")
        expect(await fs.readFile(file, "utf8")).toBe("after")
      },
    })
  })
})
