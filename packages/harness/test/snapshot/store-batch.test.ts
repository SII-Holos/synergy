import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotLifecycle } from "../../src/session/snapshot-lifecycle"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("ownsMany verifies every hash in one batch", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const owned: string[] = []
        for (const content of ["first", "second", "third"]) {
          await Bun.write(path.join(tmp.path, "file.txt"), content)
          owned.push((await Snapshot.track(session.id))!)
        }
        const missing = "a".repeat(40)
        const invalid = "nope"
        const result = await SnapshotStore.ownsMany(scope.id, session.id, [...owned, missing, invalid, owned[0]!])
        for (const hash of owned) expect(result.has(hash)).toBe(true)
        expect(result.has(missing)).toBe(false)
        expect(result.has(invalid)).toBe(false)
      },
    })
  }))

test("ownsMany batch-verifies object types in a legacy repository", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, session.id), {
          version: 2,
          backend: "legacy",
        })
        const repo = SnapshotStore.legacyRepository(scope.id, session.id)
        await fs.mkdir(repo, { recursive: true })
        await SnapshotGit.run(["git", "init", "--bare", repo], path.dirname(repo))
        const tree = await SnapshotStore.command(repo, ["mktree"])
        const result = await SnapshotStore.ownsMany(scope.id, session.id, [tree, "b".repeat(40)])
        expect(result.has(tree)).toBe(true)
        expect(result.has("b".repeat(40))).toBe(false)
      },
    })
  }))

test("adopt creates a ref for every retained snapshot", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const source = await Session.create({ scope })
        const hashes: string[] = []
        for (const content of ["one", "two", "three", "four"]) {
          await Bun.write(path.join(tmp.path, "file.txt"), content)
          hashes.push((await Snapshot.track(source.id))!)
        }
        const target = await Session.create({ scope })
        const { missing } = await SnapshotLifecycle.adopt({
          scopeID: scope.id,
          sourceSessionID: source.id,
          targetSessionID: target.id,
          hashes,
        })
        expect(missing).toEqual([])
        for (const hash of hashes) expect(await SnapshotStore.owns(scope.id, target.id, hash)).toBe(true)
      },
    })
  }))

test("ownsMany requires the requested hash's exact reference", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        await Bun.write(path.join(tmp.path, "file.txt"), "first")
        const first = (await Snapshot.track(session.id))!
        await Bun.write(path.join(tmp.path, "file.txt"), "second")
        const second = (await Snapshot.track(session.id))!
        const repo = SnapshotStore.repository(scope.id)
        await SnapshotStore.command(repo, ["update-ref", SnapshotStore.reference(session.id, first), second])
        await SnapshotStore.command(repo, ["update-ref", "-d", SnapshotStore.reference(session.id, second)])
        expect(await SnapshotStore.owns(scope.id, session.id, second)).toBe(false)
        expect(await SnapshotStore.ownsMany(scope.id, session.id, [first, second])).toEqual(new Set())
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
