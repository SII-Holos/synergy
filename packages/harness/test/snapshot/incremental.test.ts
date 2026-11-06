import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "../../src/scope/context"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotCapture } from "../../src/session/snapshot-capture"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotLive } from "../../src/session/snapshot-live"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("live revisions retain readers without writing permanent roots or retaining edit churn", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const sessionID = "live-reader"
        const file = path.join(directory.path, "a.txt")
        await Bun.write(file, "before\n")
        const from = (await Snapshot.track(sessionID))!
        const live = await SnapshotLive.create(sessionID, from)
        try {
          await Bun.write(file, "first\n")
          const first = await live.refresh(["a.txt"])
          const release = SnapshotLive.retain(sessionID, first)
          for (let index = 0; index < 5; index++) {
            await Bun.write(file, `next ${index}\n`)
            await live.refresh(["a.txt"])
          }
          const old = await Snapshot.liveVersions(sessionID, first, "a.txt")
          expect(old.after.content).toBe("first\n")
          expect((await Snapshot.liveDiff(sessionID, first, "a.txt")).patch).toContain("+first")
          expect(
            await SnapshotStore.command(SnapshotStore.repository(ScopeContext.current.scope.id), [
              "for-each-ref",
              "--format=%(objectname)",
            ]),
          ).toBe(from)
          await release()
          await expect(Snapshot.liveVersions(sessionID, first, "a.txt")).rejects.toThrow("expired")
          await Bun.write(file, "before\n")
          const reverted = await live.refresh(["a.txt"])
          expect(await Snapshot.liveStatistics(sessionID, reverted)).toEqual([])
          expect(await live.retainedObjects()).toBe(0)
        } finally {
          await live.close()
        }
      },
    })
  }))

test("dirty capture reads only affected bytes and preserves net changes, removals and ignore rules", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const sessionID = "incremental"
        await Bun.write(path.join(directory.path, "note.txt"), "baseline\n")
        await Bun.write(path.join(directory.path, "untouched.txt"), "keep\n")
        await Bun.write(path.join(directory.path, "nested/.gitignore"), "*.tmp\n")
        const baseline = (await Snapshot.track(sessionID))!
        const refresh = (paths: string[]) =>
          SnapshotStore.withSession(sessionID, async () => {
            const operation = SnapshotStore.current()
            await SnapshotCapture.refresh(operation, undefined, undefined, () => {}, { paths })
            const result = await SnapshotGit.run(
              ["git", "--git-dir", operation.repository, "write-tree"],
              directory.path,
              { GIT_INDEX_FILE: operation.index },
            )
            await SnapshotStore.retainCurrent(result.text.trim())
            return result.text.trim()
          })
        await Bun.write(path.join(directory.path, "note.txt"), "changed\nextra\n")
        const open = fs.open
        const reads: string[] = []
        using measured = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
          if (String(file).startsWith(directory.path)) reads.push(path.relative(directory.path, String(file)))
          return open(file, flags, mode)
        })
        const changed = await refresh(["note.txt"])
        expect(reads).toEqual(["note.txt"])
        expect(await Snapshot.statistics(baseline, changed, sessionID)).toMatchObject([
          { file: "note.txt", additions: 2, deletions: 1 },
        ])
        expect((await Snapshot.statistics(baseline, changed, sessionID))[0]!.patch).toBeUndefined()
        await Bun.write(path.join(directory.path, "note.txt"), "baseline\n")
        expect(await refresh(["note.txt"])).toBe(baseline)
        await Bun.write(path.join(directory.path, "nested/new.txt"), "new\n")
        await Bun.write(path.join(directory.path, "nested/skip.tmp"), "ignored\n")
        const added = await refresh(["nested"])
        expect((await Snapshot.statistics(baseline, added, sessionID)).map((file) => file.file)).toEqual([
          "nested/new.txt",
        ])
        await fs.rm(path.join(directory.path, "nested/new.txt"))
        expect(await refresh(["nested/new.txt"])).toBe(baseline)
      },
    })
  }))

test("large live refreshes release every raw-content batch after hashing", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const sessionID = "live-batches"
        const from = (await Snapshot.track(sessionID))!
        const live = await SnapshotLive.create(sessionID, from)
        try {
          const files = Array.from({ length: 530 }, (_, index) => `file-${index}.txt`)
          await Promise.all(files.map((file) => Bun.write(path.join(directory.path, file), file)))
          const revision = await live.refresh(files)
          const temporary = await SnapshotLive.read(sessionID, revision, async (value) =>
            fs.readdir(value.owner.operation.temporary),
          )
          expect(temporary.filter((file) => file.startsWith("capture-"))).toEqual([])
          expect(await Snapshot.liveStatistics(sessionID, revision)).toHaveLength(files.length)
          await Promise.all(files.map((file) => fs.rm(path.join(directory.path, file))))
          await live.refresh(files)
          expect(await live.retainedObjects()).toBe(0)
        } finally {
          await live.close()
        }
      },
    })
  }))

test("new Runtime observation reclaims proven abandoned repositories while preserving live and unknown owners", async () => {
  await using fresh = await testRuntime()
  await fresh.run(async () => {
    const { Global } = await import("../../src/global")
    const root = path.join(Global.Path.cache, "snapshot-live")
    const child = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    await Bun.write(path.join(root, "live-abandoned", "owner.json"), JSON.stringify({ pid: child.pid }))
    await Bun.write(path.join(root, "live-running", "owner.json"), JSON.stringify({ pid: process.pid }))
    await Bun.write(path.join(root, "live-unknown", "partial"), "preserve")
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const from = (await Snapshot.track("recover-live"))!
        const live = await SnapshotLive.create("recover-live", from)
        await live.close()
        expect((await fs.readdir(root)).sort()).toEqual(["live-running", "live-unknown"])
        expect(await Snapshot.statistics(from, from, "recover-live")).toEqual([])
      },
    })
  })
})

test("live statistics compare dirty paths while retaining complete immutable net results", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const sessionID = "incremental-statistics"
        const files = Array.from({ length: 64 }, (_, index) => `group/${index}-${"name".repeat(20)}.txt`)
        for (const file of files) await Bun.write(path.join(directory.path, file), "original\n")
        await Bun.write(path.join(directory.path, ".gitignore"), "*.tmp\n")
        const from = (await Snapshot.track(sessionID))!
        const live = await SnapshotLive.create(sessionID, from)
        try {
          for (const file of files) await Bun.write(path.join(directory.path, file), "changed\n")
          const first = await live.refresh(["group"])
          const original = await Snapshot.liveStatistics(sessionID, first)
          const release = SnapshotLive.retain(sessionID, first)
          try {
            expect(original).toHaveLength(64)
            await Bun.write(path.join(directory.path, files[0]!), "new\nsecond\n")
            const next = await live.refresh([files[0]!])
            const run = SnapshotGit.run
            let comparedBytes = 0
            using measured = spyOn(SnapshotGit, "run").mockImplementation(async (...args) => {
              const result = await run(...args)
              if (args[0].includes("--numstat")) comparedBytes += result.bytes.length
              return result
            })
            const changed = await Snapshot.liveStatistics(sessionID, next)
            expect(changed).toHaveLength(64)
            expect(changed.find((row) => row.file === files[0])?.additions).toBe(2)
            expect(comparedBytes).toBeLessThan(250)
            expect(await Snapshot.liveStatistics(sessionID, first)).toEqual(original)
            await Bun.write(path.join(directory.path, files[0]!), "original\n")
            expect(await Snapshot.liveStatistics(sessionID, await live.refresh([files[0]!]))).toHaveLength(63)
            await Bun.write(path.join(directory.path, "extra.tmp"), "now visible\n")
            await Bun.write(path.join(directory.path, ".gitignore"), "")
            const calibrated = await Snapshot.liveStatistics(sessionID, await live.refresh([".gitignore"]))
            expect(calibrated.map((row) => row.file)).toContain("extra.tmp")
            await fs.rm(path.join(directory.path, "group"), { recursive: true })
            const removed = await Snapshot.liveStatistics(sessionID, await live.refresh(["group"]))
            expect(
              removed
                .filter((row) => row.file.startsWith("group/"))
                .every((row) => row.additions === 0 && row.deletions === 1),
            ).toBe(true)
            expect(removed).toHaveLength(66)
          } finally {
            await release()
          }
        } finally {
          await live.close()
        }
      },
    })
  }))

test("child invalidations include files replaced by a directory in the complete net statistics", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const sessionID = "file-directory-statistics"
        const file = path.join(directory.path, "parent")
        await Bun.write(file, "original\n")
        const from = (await Snapshot.track(sessionID))!
        const live = await SnapshotLive.create(sessionID, from)
        try {
          await Bun.write(file, "changed\nextra\n")
          expect(await Snapshot.liveStatistics(sessionID, await live.refresh(["parent"]))).toMatchObject([
            { file: "parent", additions: 2, deletions: 1 },
          ])
          await fs.rm(file)
          await Bun.write(path.join(file, "child.txt"), "nested\n")
          expect(await Snapshot.liveStatistics(sessionID, await live.refresh(["parent/child.txt"]))).toMatchObject([
            { file: "parent", additions: 0, deletions: 1 },
            { file: "parent/child.txt", additions: 1, deletions: 0 },
          ])
          await fs.rm(file, { recursive: true })
          await Bun.write(file, "original\n")
          expect(await Snapshot.liveStatistics(sessionID, await live.refresh(["parent"]))).toEqual([])
          await Bun.write(file, "x".repeat(2 * 1024 * 1024 + 1))
          const omitted = await live.refresh(["parent"])
          expect(await Snapshot.liveStatistics(sessionID, omitted)).toEqual([])
          await fs.rm(file)
          await Bun.write(path.join(file, "child.txt"), "nested\n")
          const recovered = await live.refresh(["parent/child.txt"])
          expect(await SnapshotLive.read(sessionID, recovered, async (value) => value.omissions)).toEqual([])
          expect(await Snapshot.liveStatistics(sessionID, recovered)).toMatchObject([
            { file: "parent", additions: 0, deletions: 1 },
            { file: "parent/child.txt", additions: 1, deletions: 0 },
          ])
        } finally {
          await live.close()
        }
      },
    })
  }))
