import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { Snapshot } from "../../src/session/snapshot"
import { ScopeContext } from "../../src/scope/context"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"

function fakeSessionID(): string {
  return Identifier.descending("session")
}

describe("Snapshot per-session isolation", () => {
  test("track() retains independent session ownership in a shared repository", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const sessionA = fakeSessionID()
        const sessionB = fakeSessionID()

        await Bun.write(path.join(tmp.path, "only_in_a.txt"), "session A content")
        const hashA = await Snapshot.track(sessionA)

        await Bun.write(path.join(tmp.path, "only_in_b.txt"), "session B content")
        const hashB = await Snapshot.track(sessionB)

        expect(hashA).toBeTruthy()
        expect(hashB).toBeTruthy()
        expect(hashA).not.toBe(hashB)

        expect(await SnapshotStore.owns(scopeID, sessionA, hashA!)).toBe(true)
        expect(await SnapshotStore.owns(scopeID, sessionB, hashB!)).toBe(true)
        expect(await SnapshotStore.owns(scopeID, sessionB, hashA!)).toBe(false)
        expect(await SnapshotStore.owns(scopeID, sessionA, hashB!)).toBe(false)
      },
    })
  })

  test("revert() in one session preserves another session's changes on non-overlapping files", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionA = fakeSessionID()
        const sessionB = fakeSessionID()

        await Bun.write(path.join(tmp.path, "file_a.txt"), "A version 1")
        const hashA1 = await Snapshot.track(sessionA)

        await Bun.write(path.join(tmp.path, "file_b.txt"), "B version 1")
        await Snapshot.track(sessionB)

        await Bun.write(path.join(tmp.path, "file_a.txt"), "A version 2")
        await Bun.write(path.join(tmp.path, "file_b.txt"), "B version 2")

        const patchA = {
          hash: hashA1!,
          files: [path.join(tmp.path, "file_a.txt")],
        }
        await Snapshot.revert([patchA], sessionA)

        const contentA = await Bun.file(path.join(tmp.path, "file_a.txt")).text()
        expect(contentA).toBe("A version 1")

        const contentB = await Bun.file(path.join(tmp.path, "file_b.txt")).text()
        expect(contentB).toBe("B version 2")
      },
    })
  })

  test("restore() only restores tracked files, not full working tree", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = fakeSessionID()

        await Bun.write(path.join(tmp.path, "file_a.txt"), "original a")
        const snapshot = await Snapshot.track(sessionID)
        expect(snapshot).toBeTruthy()

        await Bun.write(path.join(tmp.path, "file_a.txt"), "modified a")
        await Bun.write(path.join(tmp.path, "file_b.txt"), "should survive restore")

        await Snapshot.restore(snapshot!, sessionID)

        const bExists = await Bun.file(path.join(tmp.path, "file_b.txt")).exists()
        expect(bExists).toBe(true)

        const contentA = await Bun.file(path.join(tmp.path, "file_a.txt")).text()
        expect(contentA).toBe("modified a")
      },
    })
  })

  test("first track() initializes the Scope object store", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const sessionID = fakeSessionID()
        const repoPath = SnapshotStore.repository(scopeID)

        await expect(fs.stat(repoPath)).rejects.toThrow()

        await Bun.write(path.join(tmp.path, "hello.txt"), "hello world")
        const hash = await Snapshot.track(sessionID)
        expect(hash).toBeTruthy()

        const stat = await fs.stat(repoPath)
        expect(stat.isDirectory()).toBe(true)

        const revParse = await $`git --git-dir ${repoPath} rev-parse --git-dir`.quiet().nothrow()
        expect(revParse.exitCode).toBe(0)
      },
    })
  })

  test("patch() with a hash from another session returns empty files", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionA = fakeSessionID()
        const sessionB = fakeSessionID()

        await Bun.write(path.join(tmp.path, "a.txt"), "A content")
        const hashA = await Snapshot.track(sessionA)
        expect(hashA).toBeTruthy()

        await Bun.write(path.join(tmp.path, "a.txt"), "A modified")

        const patchB = await Snapshot.patch(hashA!, sessionB)
        expect(patchB.files).toEqual([])
      },
    })
  })

  test("diff() with a hash from another session returns empty string", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionA = fakeSessionID()
        const sessionB = fakeSessionID()

        await Bun.write(path.join(tmp.path, "diff_a.txt"), "diff content A")
        const hashA = await Snapshot.track(sessionA)
        expect(hashA).toBeTruthy()

        await Bun.write(path.join(tmp.path, "diff_a.txt"), "diff content modified")

        const diffResult = await Snapshot.diff(hashA!, sessionB)
        expect(diffResult).toBe("")
      },
    })
  })

  test("multiple track() calls within the same session retain all of that session’s trees", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const sessionID = fakeSessionID()
        const repoPath = SnapshotStore.repository(scopeID)

        await Bun.write(path.join(tmp.path, "first.txt"), "first content")
        const hash1 = await Snapshot.track(sessionID)
        expect(hash1).toBeTruthy()

        await Bun.write(path.join(tmp.path, "second.txt"), "second content")
        const hash2 = await Snapshot.track(sessionID)
        expect(hash2).toBeTruthy()
        expect(hash2).not.toBe(hash1)

        const cat1 = await $`git --git-dir ${repoPath} cat-file -t ${hash1!}`.quiet().nothrow()
        expect(cat1.exitCode).toBe(0)

        const cat2 = await $`git --git-dir ${repoPath} cat-file -t ${hash2!}`.quiet().nothrow()
        expect(cat2.exitCode).toBe(0)
      },
    })
  })

  test("diffSummary() with hashes from different sessions returns empty array", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionA = fakeSessionID()
        const sessionB = fakeSessionID()

        await Bun.write(path.join(tmp.path, "full_a.txt"), "A v1")
        const fromA = await Snapshot.track(sessionA)
        await Bun.write(path.join(tmp.path, "full_a.txt"), "A v2")
        const toA = await Snapshot.track(sessionA)

        const diffs = await Snapshot.diffSummary(fromA!, toA!, sessionB)
        expect(diffs).toEqual([])
      },
    })
  })
})
