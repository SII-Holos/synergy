import { expect, spyOn, test } from "bun:test"
import { z } from "zod"
import fs from "node:fs/promises"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"
import { upgradeImportedRecord } from "../../src/migration/import"
import { snapshotOwnershipMigrations } from "../../src/session/snapshot-ownership-migration"

for (const backend of ["native", "stored"] as const)
  test(`${backend} snapshots resolve one canonical retention identity for reads, later captures and deletion`, async () => {
    await using runtime = await testRuntime({
      register() {
        if (backend === "stored") SnapshotStore.registerStorage(storedSnapshots())
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null, environmentID: null })
          const privateID = "transfer_snapshot_fixture"
          const operation = await SnapshotStore.resolveRepository("home", privateID)
          await SnapshotStore.initialize(operation)
          const tree = async (text: string) => {
            const blob = await SnapshotStore.command(
              operation.repository,
              ["hash-object", "-w", "--stdin"],
              undefined,
              text,
            )
            return SnapshotStore.command(operation.repository, ["mktree"], undefined, `100644 blob ${blob}\tfile.txt\n`)
          }
          const original = await tree("historical object")
          await SnapshotStore.retainMany("home", privateID, [original])
          expect(await SnapshotStore.owns("home", privateID, original)).toBe(true)
          expect(await SnapshotStore.owns("home", session.id, original)).toBe(false)
          const publish = async () => {
            await SnapshotStore.write(StoragePath.snapshotOwner("home", session.id), {
              version: 3,
              backend: "shared",
              retentionID: privateID,
            })
            await Storage.remove(StoragePath.snapshotOwner("home", privateID))
          }
          await expect(
            Storage.transaction(async () => {
              await publish()
              throw new Error("Activation rolled back")
            }),
          ).rejects.toThrow("Activation rolled back")
          expect(await SnapshotStore.owns("home", session.id, original)).toBe(false)
          expect(await SnapshotStore.owns("home", privateID, original)).toBe(true)
          await Storage.transaction(publish)
          expect(await SnapshotStore.owns("home", session.id, original)).toBe(true)
          expect(await SnapshotStore.owns("home", privateID, original)).toBe(false)
          const later = await tree("later capture")
          await SnapshotStore.withSession(
            session.id,
            async () => {
              expect(await SnapshotStore.retainCurrent(later)).toBe(true)
              expect(await SnapshotStore.ownsCurrentRoots([original, later])).toBe(true)
            },
            undefined,
            { historical: true },
          )
          await SnapshotStore.retainMany("home", session.id, [later])
          expect(await SnapshotStore.ownsMany("home", session.id, [original, later])).toEqual(
            new Set([original, later]),
          )
          expect(
            await SnapshotGit.checked(operation.repository, [
              "rev-parse",
              "--verify",
              SnapshotStore.reference(privateID, later),
            ]),
          ).toBe(later)
          await expect(
            SnapshotGit.checked(operation.repository, [
              "rev-parse",
              "--verify",
              SnapshotStore.reference(session.id, later),
            ]),
          ).rejects.toThrow()
          await Session.remove(session.id)
          expect(await SnapshotStore.owns("home", session.id, original)).toBe(false)
          expect(await Storage.count({ prefix: ["sessions", "home", privateID, "snapshot_content"] })).toBe(0)
          await expect(
            SnapshotGit.checked(operation.repository, [
              "rev-parse",
              "--verify",
              SnapshotStore.reference(privateID, original),
            ]),
          ).rejects.toThrow()
        },
      }),
    )
  }, 15000)

for (const backend of ["native", "stored"] as const)
  test(`${backend} adopted Snapshot ownership survives restart without reviving the private preparation owner`, async () => {
    await using home = await tmpdir()
    const register = () => {
      if (backend === "stored") SnapshotStore.registerStorage(storedSnapshots())
    }
    const runtime = await testRuntime({ home: home.path, register })
    const original = await runtime.run(async () => {
      const privateID = "transfer_snapshot_restart"
      const sessionID = "adopted-snapshot-session"
      const operation = await SnapshotStore.resolveRepository("home", privateID)
      await SnapshotStore.initialize(operation)
      const blob = await SnapshotStore.command(
        operation.repository,
        ["hash-object", "-w", "--stdin"],
        undefined,
        "retained after restart",
      )
      const root = await SnapshotStore.command(
        operation.repository,
        ["mktree"],
        undefined,
        `100644 blob ${blob}\tfile.txt\n`,
      )
      await SnapshotStore.retainMany("home", privateID, [root])
      await Storage.transaction(async () => {
        await SnapshotStore.write(StoragePath.snapshotOwner("home", sessionID), {
          version: 3,
          backend: "shared",
          retentionID: privateID,
        })
        await Storage.remove(StoragePath.snapshotOwner("home", privateID))
      })
      return { privateID, sessionID, root, repository: operation.repository }
    })
    await runtime.close()
    if (backend === "stored") await fs.rm(original.repository, { recursive: true })
    await using reopened = await testRuntime({ home: home.path, register })
    await reopened.run(async () => {
      expect(await SnapshotStore.owns("home", original.privateID, original.root)).toBe(false)
      expect(await SnapshotStore.owns("home", original.sessionID, original.root)).toBe(true)
      expect(await SnapshotStore.command(original.repository, ["show", `${original.root}:file.txt`])).toBe(
        "retained after restart",
      )
      expect(await SnapshotStore.owner("home", original.sessionID)).toEqual({
        version: 3,
        backend: "shared",
        retentionID: original.privateID,
      })
    })
  })

test("cold v2 snapshot owners migrate through the central record contract and unknown ownership versions are rejected", async () => {
  await using home = await tmpdir()
  const runtime = await testRuntime({ home: home.path })
  const original = await runtime.run(async () => {
    const sessionID = "legacy-owner"
    const operation = await SnapshotStore.resolveRepository("home", sessionID)
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "legacy",
    )
    const hash = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("home", sessionID, [hash])
    const key = StoragePath.snapshotOwner("home", sessionID)
    await Storage.write(key, { version: 2, backend: "shared" })
    return { key, hash, sessionID }
  })
  await runtime.close()
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(async () => {
    expect(await SnapshotStore.owner("home", original.sessionID)).toEqual({
      version: 3,
      backend: "shared",
      retentionID: original.sessionID,
    })
    expect(await SnapshotStore.owns("home", original.sessionID, original.hash)).toBe(true)
    expect(await Storage.read(original.key)).toEqual({ version: 2, backend: "shared" })
    expect(upgradeImportedRecord(original.key, { version: 2, backend: "shared" })).toEqual({
      version: 3,
      backend: "shared",
      retentionID: original.sessionID,
    })
    expect(
      upgradeImportedRecord(StoragePath.snapshotDeletion("home", "pending-delete"), { version: 2, backend: "shared" }),
    ).toEqual({
      version: 3,
      backend: "shared",
      retentionID: "pending-delete",
    })
    await snapshotOwnershipMigrations[0].up(() => {})
    expect(await Storage.read(original.key)).toEqual({
      version: 3,
      backend: "shared",
      retentionID: original.sessionID,
    })
    const unknownKey = StoragePath.snapshotOwner("home", "future-owner")
    await Storage.write(unknownKey, { version: 4, backend: "shared", retentionID: original.sessionID })
    await expect(SnapshotStore.owns("home", "future-owner", original.hash)).rejects.toThrow()
    await Storage.write(unknownKey, { version: 2, backend: "shared", retentionID: original.sessionID })
    await expect(SnapshotStore.owner("home", "future-owner")).rejects.toThrow("cannot grant retention indirection")
    const oldSchema = z.object({ version: z.literal(2), backend: z.string() })
    expect(oldSchema.safeParse(await Storage.read(original.key)).success).toBe(false)
  })
})

test("an exact Snapshot ownership batch reads only the requested reference evidence", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const sessionID = "large-retention-owner"
    const operation = await SnapshotStore.resolveRepository("home", sessionID)
    await SnapshotStore.initialize(operation)
    const root = await SnapshotStore.command(operation.repository, ["mktree"])
    await SnapshotStore.retainMany("home", sessionID, [root])
    const updates = Array.from(
      { length: 256 },
      (_, index) =>
        `update ${SnapshotStore.reference(sessionID, (index + 1).toString(16).padStart(40, "0"))} ${root}\n`,
    ).join("")
    await SnapshotStore.command(operation.repository, ["update-ref", "--stdin"], undefined, updates)
    const command = SnapshotGit.run
    let responseBytes = 0
    using reads = spyOn(SnapshotGit, "run").mockImplementation(async (...args) => {
      const result = await command(...args)
      responseBytes += result.bytes.byteLength
      return result
    })
    expect(await SnapshotStore.ownsMany("home", sessionID, [root])).toEqual(new Set([root]))
    expect(responseBytes).toBeLessThan(16 * 1024)
  })
})
