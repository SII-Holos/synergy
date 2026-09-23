import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "../../src/scope/context"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

describe("Workspace snapshots", () => {
  test("captures exact bytes independently of Git attributes and restored timestamps", () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        fn: async () => {
          const session = "snapshot-native-bytes"
          const filename = path.join(directory.path, "note.txt")
          await fs.writeFile(path.join(directory.path, ".gitattributes"), "*.txt text eol=lf ident\n")
          await fs.writeFile(filename, "original\r\n$Id: original $\r\n")
          const before = await Snapshot.track(session)
          const stat = await fs.stat(filename)
          const repo = SnapshotStore.repository(ScopeContext.current.scope.id)
          const content = await SnapshotGit.run(
            ["git", "--git-dir", repo, "show", `${before}:note.txt`],
            directory.path,
          )
          expect(content.text).toBe("original\r\n$Id: original $\r\n")
          await fs.writeFile(filename, "modified\r\n$Id: original $\r\n")
          await fs.utimes(filename, stat.atime, stat.mtime)
          const after = await Snapshot.track(session)
          expect(after).not.toBe(before)
          expect((await Snapshot.patch(before!, session)).files).toEqual([filename])
          const retained = await SnapshotGit.run(
            ["git", "--git-dir", repo, "show", `${after}:note.txt`],
            directory.path,
          )
          expect(retained.text).toBe("modified\r\n$Id: original $\r\n")
        },
      })
    }))

  test("preserves nested ignore rules, tracked ignored files and literal symbolic links", () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        fn: async () => {
          const session = "snapshot-native-ignore"
          await fs.mkdir(path.join(directory.path, "nested"))
          await fs.writeFile(path.join(directory.path, "already.txt"), "tracked")
          await Snapshot.track(session)
          await fs.writeFile(path.join(directory.path, ".gitignore"), "*.txt\n!nested/keep.txt\n")
          await fs.writeFile(path.join(directory.path, "nested", ".gitignore"), "!again.txt\n")
          for (const name of ["skip.txt", "nested/keep.txt", "nested/again.txt", "nested/skip.txt"])
            await fs.writeFile(path.join(directory.path, name), name)
          if (process.platform !== "win32") await fs.symlink("missing.txt", path.join(directory.path, "dangling"))
          const tree = await Snapshot.track(session)
          const repo = SnapshotStore.repository(ScopeContext.current.scope.id)
          const listing = await SnapshotGit.run(
            ["git", "--git-dir", repo, "ls-tree", "-r", "--name-only", tree!],
            directory.path,
          )
          expect(listing.exitCode).toBe(0)
          expect(listing.text.trim().split("\n")).toEqual([
            ".gitignore",
            "already.txt",
            ...(process.platform === "win32" ? [] : ["dangling"]),
            "nested/.gitignore",
            "nested/again.txt",
            "nested/keep.txt",
          ])
          if (process.platform !== "win32")
            expect(await SnapshotStore.command(repo, ["show", `${tree}:dangling`])).toBe("missing.txt")
        },
      })
    }))

  test("captures text in a non-Git Workspace with its stable binding identity", () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      const scope = await directory.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = "snapshot-non-git"
          await Bun.write(path.join(directory.path, "note.txt"), "before\n")
          const before = await Snapshot.track(session)
          expect(before).toMatch(SnapshotStore.OID)
          await Bun.write(path.join(directory.path, "note.txt"), "after\n")
          const patch = await Snapshot.patch(before!, session)
          expect(patch.files).toEqual([path.join(directory.path, "note.txt")])
          expect(patch).toMatchObject({
            workspace: {
              id: ScopeContext.current.workspace!.id,
              generation: ScopeContext.current.workspace!.generation,
              root: directory.path,
            },
          })
          expect(await Bun.file(path.join(directory.path, ".git", "HEAD")).exists()).toBe(false)
        },
      })
    }))

  test("preserves literal filenames and byte sizes through capture and historical diffs", () =>
    runtime.run(async () => {
      await using directory = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await directory.scope(),
        fn: async () => {
          const names =
            process.platform === "win32"
              ? ["unicode-你好.txt", "[literal].txt"]
              : [" leading.txt", "trailing.txt ", "tab\tname.txt", "line\nname.txt", "back\\slash.txt", "[literal].txt"]
          const session = "snapshot-literal-paths"
          for (const name of names) await Bun.write(path.join(directory.path, name), "原来\n")
          const from = await Snapshot.track(session)
          expect(from).toMatch(SnapshotStore.OID)
          for (const name of names) await Bun.write(path.join(directory.path, name), "新内容\n")
          const to = await Snapshot.track(session)
          expect(to).toMatch(SnapshotStore.OID)
          expect((await Snapshot.patch(from!, session)).files.sort()).toEqual(
            names.map((name) => path.join(directory.path, name)).sort(),
          )
          const diffs = await Snapshot.diffSummary(from!, to!, session)
          expect(diffs.map((diff) => diff.file).sort()).toEqual(names.sort())
          for (const diff of diffs)
            expect(diff).toMatchObject({ additions: 1, deletions: 1, beforeBytes: 7, afterBytes: 10 })
          expect(diffs.every((diff) => diff.patch?.includes("+新内容"))).toBe(true)
        },
      })
    }))

  test("historical diffs remain readable without any local Workspace", () =>
    runtime.run(async () => {
      await using directory = await tmpdir({ git: true })
      const scope = await directory.scope()
      const session = "snapshot-unbound-history"
      const [from, to] = await ScopeContext.provide({
        scope,
        fn: async () => {
          await Bun.write(path.join(directory.path, "note.txt"), "before\n")
          const from = await Snapshot.track(session)
          await Bun.write(path.join(directory.path, "note.txt"), "after\n")
          return [from!, (await Snapshot.track(session))!]
        },
      })
      await fs.rm(directory.path, { recursive: true, force: true })
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          const diffs = await Snapshot.diffSummary(from, to, session)
          expect(diffs).toHaveLength(1)
          expect(diffs[0]).toMatchObject({ file: "note.txt", additions: 1, deletions: 1 })
        },
      })
    }))

  test("a new binding generation gets a fresh disposable index in the same Scope object store", () =>
    runtime.run(async () => {
      await using directory = await tmpdir({ git: true })
      const scope = await directory.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const workspace = ScopeContext.current.workspace!
          const first = await SnapshotStore.withSession("snapshot-index-binding", async () => SnapshotStore.current())
          const second = await ScopeContext.provide({
            scope,
            workspace: { ...workspace, generation: workspace.generation! + 1 },
            fn: () => SnapshotStore.withSession("snapshot-index-binding", async () => SnapshotStore.current()),
          })
          expect(first.repository).toBe(second.repository)
          expect(first.index).not.toBe(second.index)
        },
      })
    }))
})
