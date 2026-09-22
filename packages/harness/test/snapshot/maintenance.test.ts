import { describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { $ } from "bun"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotTransfer } from "../../src/session/snapshot-transfer"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotRecords } from "../../src/session/snapshot-records"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("empty optional step snapshots carry no root while malformed nonempty references remain errors", () =>
  runtime.run(() => {
    for (const type of ["step-start", "step-finish"]) {
      expect(SnapshotRecords.partRoots({ type, snapshot: "" })).toEqual([])
      expect(() => SnapshotRecords.partRoots({ type, snapshot: "invalid" })).toThrow("Invalid historical")
    }
    expect(() => SnapshotRecords.partRoots({ type: "patch", hash: "" })).toThrow("Invalid historical")
  }))

test("migration materializes Git's virtual empty tree before publishing historical retention", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(source)
        const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID("message-empty"),
            Identifier.asPartID("part-empty"),
          ),
          { type: "step-start", snapshot: tree },
        )
        expect(await SnapshotStore.command(source, ["cat-file", "-t", tree])).toBe("tree")
        expect(
          await SnapshotStore.command(source, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]),
        ).not.toContain(tree)
        await SnapshotMaintenance.registerLegacy(undefined, scope.id)
        expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("migrated")
        expect(
          await SnapshotStore.command(SnapshotStore.repository(scope.id), [
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname)",
          ]),
        ).toContain(tree)
        expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(true)
      },
    })
  }))

test("migration consolidates reclaimed repositories with confirmed session records", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const reclaimed = Identifier.asScopeID("__reclaimed__")
        const info = { ...session, scope: { ...session.scope, id: reclaimed } }
        const key = StoragePath.sessionInfo(reclaimed, Identifier.asSessionID(session.id))
        await Storage.write(key, info)
        const source = SnapshotStore.legacyRepository(reclaimed, session.id)
        await SnapshotStore.initializeBareRepository(source)
        await Bun.write(path.join(tmp.path, "history.txt"), "reclaimed history")
        await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
        const tree = await SnapshotStore.command(source, ["write-tree"])
        await SnapshotMaintenance.registerLegacy(undefined, reclaimed)
        expect((await SnapshotMaintenance.migrate(reclaimed, { apply: true })).results[0].status).toBe("migrated")
        expect(await SnapshotStore.owns(reclaimed, session.id, tree)).toBe(true)
        expect(await Storage.read<typeof info>(key)).toEqual(info)
        expect(await SnapshotStore.command(SnapshotStore.repository(reclaimed), ["show", `${tree}:history.txt`])).toBe(
          "reclaimed history",
        )
      },
    })
  }))

test("migration batches retention publication while keeping every source recoverable", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const sessions = [await Session.create({ scope }), await Session.create({ scope })]
        const trees: string[] = []
        for (const session of sessions) {
          const source = SnapshotStore.legacyRepository(scope.id, session.id)
          await SnapshotStore.initializeBareRepository(source)
          await Bun.write(path.join(tmp.path, "history.txt"), session.id)
          await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
          trees.push(await SnapshotStore.command(source, ["write-tree"]))
        }
        await SnapshotMaintenance.registerLegacy(undefined, scope.id)
        const write = SnapshotStore.write
        const verified = new Set<string>()
        const open = fs.open
        {
          using publication = spyOn(fs, "open").mockImplementation(async (...args) => {
            const file = await open(...args)
            const target = SnapshotStore.repository(scope.id)
            if (
              args[0] === path.join(target, "packed-refs") ||
              sessions.some(
                (session, index) => args[0] === path.join(target, SnapshotStore.reference(session.id, trees[index])),
              )
            )
              file.sync = async () => {
                throw new Error("interrupted batch publication")
              }
            return file
          })
          const failed = await SnapshotMaintenance.migrate(scope.id, { apply: true })
          expect(failed.results.map((entry) => entry.status)).toEqual(["failed", "failed"])
          for (const session of sessions) {
            expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("legacy")
            expect(
              await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, session.id), "HEAD")).exists(),
            ).toBe(true)
          }
        }
        {
          using checkpoint = spyOn(SnapshotStore, "write").mockImplementation(async (key, value) => {
            await write(key, value)
            if (key.includes("migrations") && (value as { phase?: string }).phase === "verified") {
              verified.add(key.join("/"))
              for (const session of sessions) {
                expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("legacy")
                expect(
                  await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, session.id), "HEAD")).exists(),
                ).toBe(true)
              }
            }
          })
          const result = await SnapshotMaintenance.migrate(scope.id, { apply: true })
          expect(result.results.every((entry) => entry.status === "migrated")).toBe(true)
        }
        expect(verified.size).toBe(2)
        for (const [index, session] of sessions.entries()) {
          expect(await SnapshotStore.owns(scope.id, session.id, trees[index])).toBe(true)
          expect(
            await SnapshotStore.command(SnapshotStore.repository(scope.id), ["show", `${trees[index]}:history.txt`]),
          ).toBe(session.id)
        }
      },
    })
  }))

test("migration keeps its source until packed retention references are durable", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(source)
        await Bun.write(path.join(tmp.path, "retained.txt"), "retained")
        await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "retained.txt"])
        const tree = await SnapshotStore.command(source, ["write-tree"])
        await SnapshotMaintenance.registerLegacy(undefined, scope.id)
        const open = fs.open
        {
          using fault = spyOn(fs, "open").mockImplementation(async (...args) => {
            const file = await open(...args)
            if (
              args[0] === path.join(SnapshotStore.repository(scope.id), "packed-refs") ||
              args[0] === path.join(SnapshotStore.repository(scope.id), SnapshotStore.reference(session.id, tree))
            ) {
              file.sync = async () => {
                throw new Error("interrupted packed reference publication")
              }
            }
            return file
          })
          expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("failed")
        }
        expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("legacy")
        expect(await Bun.file(path.join(source, "HEAD")).exists()).toBe(true)
        expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("migrated")
        expect(await SnapshotStore.owns(scope.id, session.id, tree)).toBe(true)
        expect(await SnapshotStore.command(SnapshotStore.repository(scope.id), ["show", `${tree}:retained.txt`])).toBe(
          "retained",
        )
      },
    })
  }))

test("older Git keeps and flushes loose retention references instead of rewriting packed history", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(source)
        await Bun.write(path.join(tmp.path, "history.txt"), "older Git history")
        await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
        const tree = await SnapshotStore.command(source, ["write-tree"])
        await SnapshotMaintenance.registerLegacy(undefined, scope.id)
        const checked = SnapshotGit.checked
        using version = spyOn(SnapshotGit, "checked").mockImplementation(async (repo, args, options) => {
          if (args[0] === "version") return "git version 2.25.1"
          if (args.includes("pack-refs")) throw new Error("Older Git cannot durably rewrite packed references")
          return checked(repo, args, options)
        })
        expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("migrated")
        expect(
          (
            await Bun.file(
              path.join(SnapshotStore.repository(scope.id), SnapshotStore.reference(session.id, tree)),
            ).text()
          ).trim(),
        ).toBe(tree)
        expect(await SnapshotStore.command(SnapshotStore.repository(scope.id), ["show", `${tree}:history.txt`])).toBe(
          "older Git history",
        )
      },
    })
  }))

for (const phase of ["imported", "verified", "protected", "switched"] as const) {
  test(`migration resumes after durable ${phase} checkpoint`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ scope })
          const source = SnapshotStore.legacyRepository(scope.id, session.id)
          await SnapshotStore.initializeBareRepository(source)
          await Bun.write(path.join(tmp.path, "history.txt"), "survives interruption")
          await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
          const tree = await SnapshotStore.command(source, ["write-tree"])
          await SnapshotMaintenance.registerLegacy()
          const write = SnapshotStore.write
          {
            let interrupted = false
            using fault = spyOn(SnapshotStore, "write").mockImplementation(async (key, value) => {
              await write(key, value)
              if (!interrupted && key.includes("migrations") && (value as { phase?: string }).phase === phase) {
                interrupted = true
                throw new Error("simulated interruption after checkpoint")
              }
            })
            expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("failed")
          }
          expect(await Bun.file(path.join(source, "HEAD")).exists()).toBe(true)
          expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("migrated")
          expect(await SnapshotStore.owns(scope.id, session.id, tree)).toBe(true)
          expect(await Bun.file(path.join(source, "HEAD")).exists()).toBe(false)
          expect(
            (await fs.readdir(path.join(SnapshotStore.repository(scope.id), "objects", "pack"))).filter((name) =>
              name.endsWith(".keep"),
            ),
          ).toEqual([])
        },
      })
    }))
}

test("migration retains its source when switched ownership is inconsistent", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(source)
        await SnapshotMaintenance.registerLegacy(undefined, scope.id)
        const write = SnapshotStore.write
        using inconsistent = spyOn(SnapshotStore, "write").mockImplementation(async (key, value) => {
          await write(key, value)
          if (key.includes("migrations") && (value as { phase?: string }).phase === "switched")
            await write(StoragePath.snapshotOwner(scope.id, session.id), { version: 2, backend: "legacy" })
        })
        expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).results[0].status).toBe("failed")
        expect(await Bun.file(path.join(source, "HEAD")).exists()).toBe(true)
      },
    })
  }))

test("migration retains a historical tree already recovered into the shared store", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const first = await Session.create({ scope })
        const second = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, first.id)
        await SnapshotStore.initializeBareRepository(source)
        await SnapshotStore.initializeBareRepository(SnapshotStore.legacyRepository(scope.id, second.id))
        await Bun.write(path.join(tmp.path, "history.txt"), "shared recovery")
        await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
        const tree = await SnapshotStore.command(source, ["write-tree"])
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(second.id),
            Identifier.asMessageID("recovered-message"),
            Identifier.asPartID("recovered-part"),
          ),
          { type: "step-start", snapshot: tree },
        )
        await SnapshotMaintenance.registerLegacy(undefined, scope.id)
        await SnapshotMaintenance.migrate(scope.id, { apply: true, sessionID: first.id })
        const result = await SnapshotMaintenance.migrate(scope.id, { apply: true, sessionID: second.id })
        expect(result.results[0].status).toBe("migrated")
        expect(await SnapshotStore.owns(scope.id, second.id, tree)).toBe(true)
        expect(await SnapshotStore.command(SnapshotStore.repository(scope.id), ["show", `${tree}:history.txt`])).toBe(
          "shared recovery",
        )
      },
    })
  }))

test("migration materializes alternates once and preserves unknown blobs", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const pool = path.join(tmp.path, "old-pool")
        await SnapshotStore.initializeBareRepository(pool)
        await Bun.write(path.join(tmp.path, "file.txt"), "baseline")
        await SnapshotStore.command(pool, ["-C", tmp.path, "--work-tree", tmp.path, "add", "file.txt"])
        const tree = await SnapshotStore.command(pool, ["write-tree"])
        await Bun.write(path.join(tmp.path, "orphan.txt"), "orphan")
        const unknown = await SnapshotStore.command(pool, ["hash-object", "-w", path.join(tmp.path, "orphan.txt")])
        const sessions = [await Session.create({ scope }), await Session.create({ scope })]
        for (const session of sessions) {
          const repo = SnapshotStore.legacyRepository(scope.id, session.id)
          await SnapshotStore.initializeBareRepository(repo)
          await Bun.write(path.join(repo, "objects", "info", "alternates"), path.join(pool, "objects") + "\n")
        }
        await SnapshotMaintenance.registerLegacy()
        const result = await SnapshotMaintenance.migrate(scope.id, { apply: true })
        expect(result.results.every((entry) => entry.status === "migrated")).toBe(true)
        expect(result.results.filter((entry) => entry.objectsAdded === 0)).toHaveLength(1)
        await fs.rm(pool, { recursive: true })
        for (const session of sessions) expect(await SnapshotStore.owns(scope.id, session.id, tree)).toBe(true)
        expect(
          await SnapshotStore.command(SnapshotStore.repository(scope.id), [
            "rev-parse",
            `refs/synergy/preserved/${unknown}`,
          ]),
        ).toBe(unknown)
        expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(true)
      },
    })
  }))

describe("snapshot maintenance", () => {
  test("non-pruning compaction recovers interrupted import packs conservatively", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      const source = path.join(tmp.path, "interrupted")
      await SnapshotStore.initializeBareRepository(source)
      await Bun.write(path.join(tmp.path, "old.txt"), "unknown history")
      await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "old.txt"])
      const tree = await SnapshotStore.command(source, ["write-tree"])
      await SnapshotStore.initializeRepository(scope.id)
      const target = SnapshotStore.repository(scope.id)
      {
        await using catalog = await SnapshotTransfer.Catalog.create(target)
        await catalog.import(source)
      }
      await fs.rm(source, { recursive: true })
      await expect(SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })).rejects.toThrow(
        "import protection",
      )
      const recovered = await SnapshotMaintenance.compact(scope.id, { apply: true })
      expect(recovered.recoveredObjects).toBeGreaterThan(0)
      await SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })
      expect(await SnapshotStore.command(target, ["show", `${tree}:old.txt`])).toBe("unknown history")
    }))
  test("migration refuses a shared target that depends on alternates", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ scope })
          const legacy = SnapshotStore.legacyRepository(scope.id, session.id)
          await SnapshotStore.initializeBareRepository(legacy)
          await SnapshotMaintenance.registerLegacy()
          await SnapshotStore.initializeRepository(scope.id)
          await Bun.write(
            path.join(SnapshotStore.repository(scope.id), "objects", "info", "alternates"),
            path.join(legacy, "objects") + "\n",
          )
          await expect(SnapshotMaintenance.migrate(scope.id, { apply: true })).rejects.toThrow("external object")
          expect(await Bun.file(path.join(legacy, "HEAD")).exists()).toBe(true)
        },
      })
    }))
  test("migration retains unreferenced legacy trees and is idempotent", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ scope })
          const repo = SnapshotStore.legacyRepository(scope.id, session.id)
          await fs.mkdir(repo, { recursive: true })
          await $`git init --bare ${repo}`.quiet()
          const file = path.join(tmp.path, "old.txt")
          await Bun.write(file, "old history")
          await SnapshotStore.command(repo, ["-C", tmp.path, "--work-tree", tmp.path, "add", "--all"])
          const tree = await SnapshotStore.command(repo, ["write-tree"])
          await SnapshotMaintenance.registerLegacy()
          expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("legacy")
          const dry = await SnapshotMaintenance.migrate(scope.id)
          expect(dry.results.find((entry) => entry.sessionID === session.id)?.status).toBe("pending")
          expect(await Bun.file(path.join(repo, "HEAD")).exists()).toBe(true)
          const applied = await SnapshotMaintenance.migrate(scope.id, { apply: true })
          expect(applied.results.find((entry) => entry.sessionID === session.id)?.status).toBe("migrated")
          expect((await SnapshotStore.owner(scope.id, session.id))?.backend).toBe("shared")
          expect(await Bun.file(path.join(repo, "HEAD")).exists()).toBe(false)
          expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(true)
          await SnapshotMaintenance.migrate(scope.id, { apply: true })
          await Bun.write(file, "later")
          await Snapshot.revert([{ hash: tree, files: [file] }], session.id)
          expect(await Bun.file(file).text()).toBe("old history")
        },
      })
    }))

  test("pruning refuses a missing history root instead of deleting other objects", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ scope })
          await Bun.write(path.join(tmp.path, "a.txt"), "retained")
          await Snapshot.track(session.id)
          await Storage.write(
            StoragePath.messagePart(
              Identifier.asScopeID(scope.id),
              Identifier.asSessionID(session.id),
              Identifier.asMessageID("message-test"),
              Identifier.asPartID("part-test"),
            ),
            { type: "step-start", snapshot: "a".repeat(40) },
          )
          expect((await SnapshotMaintenance.check(scope.id)).ok).toBe(false)
          await expect(SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })).rejects.toThrow()
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
test("protected preparation copies the required Git closure and preserves unrelated source objects", () =>
  runtime.run(async () => {
    const { SnapshotProtection } = await import("../../src/session/snapshot-protection")
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ scope })
        const source = SnapshotStore.legacyRepository(scope.id, session.id)
        await SnapshotStore.initializeBareRepository(source)
        await Bun.write(path.join(tmp.path, "history.txt"), "required history")
        await SnapshotStore.command(source, ["-C", tmp.path, "--work-tree", tmp.path, "add", "history.txt"])
        const tree = await SnapshotStore.command(source, ["write-tree"])
        await Bun.write(path.join(tmp.path, "unknown.txt"), "unreferenced evidence")
        const unknown = await SnapshotStore.command(source, ["hash-object", "-w", path.join(tmp.path, "unknown.txt")])
        await Storage.write(["sessions", scope.id, session.id, "messages", "message", "parts", "snapshot"], {
          type: "step-start",
          snapshot: tree,
        })
        await SnapshotMaintenance.registerLegacy(undefined, scope.id, session.id)
        const data = Storage.current().artifactDirectory
        await SnapshotProtection.protect(data, "protected-fixture")
        try {
          expect(
            (await SnapshotMaintenance.migrate(scope.id, { apply: true, sessionID: session.id })).results[0].status,
          ).toBe("migrated")
          expect(await SnapshotStore.command(SnapshotStore.repository(scope.id), ["show", `${tree}:history.txt`])).toBe(
            "required history",
          )
          expect(await SnapshotStore.command(source, ["cat-file", "-p", unknown])).toBe("unreferenced evidence")
          await expect(SnapshotMaintenance.packLegacy(data, { apply: true, scopeID: scope.id })).rejects.toThrow(
            "protected",
          )
        } finally {
          await SnapshotProtection.release(data, "protected-fixture")
        }
      },
    })
  }))
