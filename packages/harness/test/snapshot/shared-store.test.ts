import { registerSnapshotTestHost } from "../support/snapshot-host"
import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileLockPath } from "@ericsanchezok/synergy-util/fs-lock"
import type { SnapshotSchema } from "../../src/session/snapshot-schema"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotLease } from "../../src/session/snapshot-lease"
import { SnapshotLifecycle } from "../../src/session/snapshot-lifecycle"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { withTimeout } from "../../src/util/timeout"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime({ register: registerSnapshotTestHost })

async function objects(repo: string) {
  const result = await SnapshotStore.command(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
  return result.split("\n").filter(Boolean).sort()
}

function observeContention(key: string, notify: () => void) {
  const filename = fileLockPath(SnapshotLease.directory(), key)
  const open = fs.open
  return spyOn(fs, "open").mockImplementation(async (...args) => {
    try {
      return await open(...args)
    } catch (error) {
      if (args[0] === filename && (error as NodeJS.ErrnoException).code === "EEXIST") notify()
      throw error
    }
  })
}

describe("shared snapshot storage", () => {
  test("excludes newly oversized literal paths while preserving files and historical objects", () =>
    runtime.run(async () => {
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
          const omissions: SnapshotSchema.Omission[] = []
          const after = await Snapshot.track("session-size", undefined, (items) => omissions.push(...items))
          expect(omissions).toEqual([{ file: "literal[1].txt", reason: "size_limit" }])
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
    }))

  test("cancellation while maintenance owns the store preserves empty snapshot results", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await Bun.write(path.join(tmp.path, "file.txt"), "before")
          const hash = (await Snapshot.track("session-cancel"))!
          await using maintenance = await SnapshotLease.acquire(scope.id, true)
          const controller = new AbortController()
          const capturing = Snapshot.track("session-cancel", controller.signal)
          const patching = Snapshot.patch(hash, "session-cancel", { signal: controller.signal })
          const diffing = Snapshot.diff(hash, "session-cancel", { signal: controller.signal })
          setTimeout(() => controller.abort(), 50)
          expect(await capturing).toBeUndefined()
          expect((await patching).files).toEqual([])
          expect(await diffing).toBe("")
        },
      })
    }))
  test("identical sessions reuse objects while retaining independent ownership", () =>
    runtime.run(async () => {
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
    }))

  test("concurrent sessions and distinct workspaces cannot overwrite each other's indexes", () =>
    runtime.run(async () => {
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
    }))

  test("parallel batches serialize shared and legacy operations using the same index", () =>
    runtime.run(async () => {
      for (const backend of ["shared", "legacy"] as const) {
        await using tmp = await tmpdir({ git: true })
        await using other = backend === "legacy" ? await tmpdir({ git: true }) : undefined
        const scope = await tmp.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            const sessionID = `same-index-${backend}`
            if (backend === "legacy") {
              await SnapshotStore.initializeBareRepository(SnapshotStore.legacyRepository(scope.id, sessionID))
              await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, sessionID), { version: 2, backend })
            }
            await Bun.write(path.join(tmp.path, "same.txt"), "same index")
            const competingWorkspace = other
              ? await ScopeContext.provide({
                  scope,
                  workspace: { type: "main", path: other.path, scopeID: scope.id },
                  fn: () => ScopeContext.current.workspace!,
                })
              : ScopeContext.current.workspace!
            if (other) await Bun.write(path.join(other.path, "same.txt"), "same index")
            const hash = await Snapshot.track(sessionID)
            expect(hash).toBeTruthy()
            const operation = await SnapshotStore.resolve(scope.id, sessionID, tmp.path, Snapshot.workspace())
            const entered = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            const contended = Promise.withResolvers<void>()
            const captured = Promise.withResolvers<void>()
            const controller = new AbortController()
            const observer = observeContention(`snapshot-index:${operation.index}`, () => contended.resolve())
            const batch = SnapshotStore.parallel(sessionID, [
              () =>
                SnapshotStore.withSession(
                  sessionID,
                  async () => {
                    const indexLock = SnapshotStore.current().index + ".lock"
                    const handle = await fs.open(indexLock, "wx")
                    try {
                      entered.resolve()
                      await release.promise
                    } finally {
                      await handle.close()
                      await fs.unlink(indexLock)
                    }
                  },
                  controller.signal,
                ),
              async () => {
                await entered.promise
                try {
                  expect(
                    await ScopeContext.provide({
                      scope,
                      workspace: competingWorkspace,
                      fn: () => Snapshot.track(sessionID, controller.signal),
                    }),
                  ).toBe(hash)
                } finally {
                  captured.resolve()
                }
              },
            ])
            const drained = Promise.allSettled([batch])
            try {
              expect(
                await withTimeout(
                  Promise.race([contended.promise.then(() => true), captured.promise.then(() => false)]),
                  10_000,
                ),
              ).toBe(true)
              expect(await Bun.file(operation.index + ".lock").exists()).toBe(true)
              release.resolve()
              await withTimeout(batch, 10_000)
              expect(await SnapshotStore.owns(scope.id, sessionID, hash!)).toBe(true)
              expect(await SnapshotStore.command(operation.repository, ["show", `${hash}:same.txt`])).toBe("same index")
            } finally {
              entered.resolve()
              release.resolve()
              controller.abort()
              await drained
              observer.mockRestore()
            }
          },
        })
      }
    }))

  test("a failed parallel action does not release same-session snapshots or deletion before its siblings settle", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const sessionID = "batch-lifecycle"
          const file = path.join(tmp.path, "lifecycle.txt")
          await Bun.write(file, "before")
          const before = await Snapshot.track(sessionID)
          expect(before).toBeTruthy()
          const failed = new Error("one parallel action failed")
          const firstDone = Promise.withResolvers<void>()
          const held = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const controller = new AbortController()
          const ordinaryController = new AbortController()
          let after: string | undefined
          const batch = SnapshotStore.parallel(sessionID, [
            async () => {
              firstDone.resolve()
              throw failed
            },
            async () => {
              await firstDone.promise
              held.resolve()
              await release.promise
              after = await Snapshot.track(sessionID, controller.signal)
            },
          ]).then(
            () => undefined,
            (error: unknown) => error,
          )
          let ordinary: Promise<string | undefined> | undefined
          let deleting: Promise<void> | undefined
          let observer: ReturnType<typeof observeContention> | undefined
          try {
            await withTimeout(held.promise, 10_000)
            await Bun.write(file, "after")
            const snapshotBlocked = Promise.withResolvers<void>()
            observer = observeContention(`snapshot-session:${scope.id}:${sessionID}`, () => snapshotBlocked.resolve())
            ordinary = Snapshot.track(sessionID, ordinaryController.signal)
            expect(
              await withTimeout(
                Promise.race([snapshotBlocked.promise.then(() => true), ordinary.then(() => false)]),
                10_000,
              ),
            ).toBe(true)
            ordinaryController.abort()
            expect(await ordinary).toBeUndefined()
            observer.mockRestore()

            const deletionBlocked = Promise.withResolvers<void>()
            observer = observeContention(`snapshot-session:${scope.id}:${sessionID}`, () => deletionBlocked.resolve())
            deleting = SnapshotLifecycle.beginDelete(scope.id, sessionID)
            expect(
              await withTimeout(
                Promise.race([deletionBlocked.promise.then(() => true), deleting.then(() => false)]),
                10_000,
              ),
            ).toBe(true)
            expect((await SnapshotStore.owner(scope.id, sessionID))?.backend).toBe("shared")
            expect(await SnapshotStore.optional(StoragePath.snapshotDeletion(scope.id, sessionID))).toBeUndefined()
            expect(await SnapshotStore.owns(scope.id, sessionID, before!)).toBe(true)
            release.resolve()
            const error = await withTimeout(batch, 10_000)
            expect(error).toBeInstanceOf(AggregateError)
            expect((error as AggregateError).errors).toEqual([failed])
            expect(after).toBeTruthy()
            expect(after).not.toBe(before)
            await deleting
            const repo = SnapshotStore.repository(scope.id)
            expect(await SnapshotStore.command(repo, ["rev-parse", SnapshotStore.reference(sessionID, after!)])).toBe(
              after!,
            )
            expect(await SnapshotStore.command(repo, ["show", `${after}:lifecycle.txt`])).toBe("after")
            await SnapshotLifecycle.completeDelete(scope.id, sessionID)
            expect((await SnapshotStore.owner(scope.id, sessionID))?.backend).toBe("deleted")
            expect(await SnapshotStore.owns(scope.id, sessionID, after!)).toBe(false)
          } finally {
            firstDone.resolve()
            release.resolve()
            ordinaryController.abort()
            controller.abort()
            await Promise.allSettled([batch, ordinary, deleting])
            observer?.mockRestore()
          }
        },
      })
    }))

  test("queued exclusive maintenance cannot deadlock child snapshots inside a parallel batch", () =>
    runtime.run(async () => {
      await using first = await tmpdir({ git: true })
      await using second = await tmpdir({ git: true })
      const scope = await first.scope()
      await Bun.write(path.join(first.path, "a.txt"), "first child")
      await Bun.write(path.join(second.path, "b.txt"), "second child")
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const sessionID = "batch-maintenance"
          const ready = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const controller = new AbortController()
          const maintenanceController = new AbortController()
          const hashes: string[] = []
          const events: string[] = []
          let started = 0
          const batch = SnapshotStore.parallel(
            sessionID,
            [first, second].map(
              (tmp, index) => () =>
                ScopeContext.provide({
                  scope,
                  workspace: { type: "main", path: tmp.path, scopeID: scope.id },
                  fn: async () => {
                    if (++started === 2) ready.resolve()
                    await release.promise
                    const hash = await Snapshot.track(sessionID, controller.signal)
                    expect(hash).toBeTruthy()
                    hashes[index] = hash!
                    events.push(`child-${index}`)
                  },
                }),
            ),
          )
          const drained = Promise.allSettled([batch])
          let maintenance: Promise<void> | undefined
          let queued: Promise<void> | undefined
          try {
            expect(
              await withTimeout(Promise.race([ready.promise.then(() => true), batch.then(() => false)]), 10_000),
            ).toBe(true)
            maintenance = SnapshotLease.use(
              scope.id,
              true,
              async () => {
                expect(hashes.every(Boolean)).toBe(true)
                expect(events).toHaveLength(2)
                events.push("maintenance")
                await SnapshotStore.command(SnapshotStore.repository(scope.id), ["fsck", "--full"])
              },
              { signal: maintenanceController.signal },
            )
            const leaseFile = Bun.file(
              path.join(Storage.current().artifactDirectory, ...StoragePath.snapshotLeases(scope.id)) + ".json",
            )
            queued = (async () => {
              for (;;) {
                maintenanceController.signal.throwIfAborted()
                const state: { owners: { exclusive: boolean }[] } = await leaseFile.json()
                if (state.owners.some((owner) => owner.exclusive)) return
                await Bun.sleep(10)
              }
            })()
            await withTimeout(
              Promise.race([
                queued,
                maintenance.then(() => {
                  throw new Error("Maintenance completed before the parallel batch released its reader")
                }),
              ]),
              10_000,
            )
            expect(events).toEqual([])
            release.resolve()
            await withTimeout(batch, 10_000)
            await withTimeout(maintenance, 10_000)
            expect(events.at(-1)).toBe("maintenance")
            expect(hashes[0]).not.toBe(hashes[1])
            expect(await SnapshotStore.ownsMany(scope.id, sessionID, hashes)).toEqual(new Set(hashes))
          } finally {
            release.resolve()
            controller.abort()
            maintenanceController.abort()
            await Promise.allSettled([drained, maintenance, queued])
          }
        },
      })
    }))

  test("parallel retainCurrent and retainMany serialize writes to an identical tree reference", () =>
    runtime.run(async () => {
      await using first = await tmpdir({ git: true })
      await using second = await tmpdir({ git: true })
      const scope = await first.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const sessionID = "batch-retain"
          await Bun.write(path.join(first.path, "same.txt"), "retained tree")
          const hash = (await Snapshot.track(sessionID))!
          expect(hash).toBeTruthy()
          const alternate = await ScopeContext.provide({
            scope,
            workspace: { type: "main", path: second.path, scopeID: scope.id },
            fn: () => ScopeContext.current.workspace!,
          })
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const currentBlocked = Promise.withResolvers<void>()
          const manyBlocked = Promise.withResolvers<void>()
          const prematureWrite = Promise.withResolvers<void>()
          const controller = new AbortController()
          const repo = SnapshotStore.repository(scope.id)
          const reference = SnapshotStore.reference(sessionID, hash)
          const referenceLock = path.join(repo, reference) + ".lock"
          const observer = observeContention(`snapshot-references:${scope.id}:${sessionID}`, () => {
            if (SnapshotStore.current().source?.id === alternate.id) currentBlocked.resolve()
            else manyBlocked.resolve()
          })
          const run = SnapshotGit.run
          let holding = false
          let released = false
          const writer = spyOn(SnapshotGit, "run").mockImplementation(async (...args) => {
            if (args[0].includes(repo) && args[0].includes("update-ref")) {
              if (!holding) {
                holding = true
                const handle = await fs.open(referenceLock, "wx")
                try {
                  entered.resolve()
                  await release.promise
                } finally {
                  await handle.close()
                  await fs.unlink(referenceLock)
                }
              } else if (!released) prematureWrite.resolve()
            }
            return run(...args)
          })
          const retained: boolean[] = []
          const batch = SnapshotStore.parallel(sessionID, [
            () =>
              SnapshotStore.withSession(
                sessionID,
                async () => {
                  retained.push(await SnapshotStore.retainCurrent(hash, controller.signal))
                },
                controller.signal,
              ),
            async () => {
              await entered.promise
              await ScopeContext.provide({
                scope,
                workspace: alternate,
                fn: () =>
                  SnapshotStore.withSession(
                    sessionID,
                    async () => {
                      retained.push(await SnapshotStore.retainCurrent(hash, controller.signal))
                    },
                    controller.signal,
                  ),
              })
            },
            async () => {
              await entered.promise
              await SnapshotStore.retainMany(scope.id, sessionID, [hash, hash], controller.signal)
            },
          ])
          const drained = Promise.allSettled([batch])
          try {
            expect(
              await withTimeout(
                Promise.race([
                  Promise.all([currentBlocked.promise, manyBlocked.promise]).then(() => true),
                  prematureWrite.promise.then(() => false),
                ]),
                10_000,
              ),
            ).toBe(true)
            expect(await Bun.file(referenceLock).exists()).toBe(true)
            released = true
            release.resolve()
            await withTimeout(batch, 10_000)
            expect(retained).toEqual([true, true])
            expect(await SnapshotStore.command(repo, ["rev-parse", "--verify", reference])).toBe(hash)
            expect(await SnapshotStore.owns(scope.id, sessionID, hash)).toBe(true)
            expect(await Bun.file(referenceLock).exists()).toBe(false)
            await SnapshotStore.command(repo, ["fsck", "--full"])
          } finally {
            released = true
            entered.resolve()
            release.resolve()
            controller.abort()
            await drained
            writer.mockRestore()
            observer.mockRestore()
          }
        },
      })
    }))

  test("tree roots keep all historical contents alive through garbage collection", () =>
    runtime.run(async () => {
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
          await Snapshot.revert([{ hash: before!, workspace: Snapshot.workspace(), files: [file] }], "session-a")
          expect(await fs.readFile(file, "utf8")).toBe("before")
          await Snapshot.revert([{ hash: after!, workspace: Snapshot.workspace(), files: [file] }], "session-a")
          expect(await fs.readFile(file, "utf8")).toBe("after")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
