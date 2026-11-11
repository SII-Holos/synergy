import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

for (const backend of ["native", "stored"] as const)
  test(`${backend} retained-root inventory follows canonical ownership without foreign roots`, async () => {
    await using runtime = await testRuntime({
      register() {
        if (backend === "stored") SnapshotStore.registerStorage(storedSnapshots())
      },
    })
    await runtime.run(async () => {
      const privateID = "inventory-private"
      const sessionID = "inventory-session"
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
      const roots = [await tree("one"), await tree("two")]
      await SnapshotStore.retainMany("home", privateID, roots)
      const foreign = await SnapshotStore.resolveRepository("home", "inventory-foreign")
      await SnapshotStore.initialize(foreign)
      const foreignRoot = await tree("foreign")
      await SnapshotStore.retainMany("home", "inventory-foreign", [foreignRoot])
      await Storage.transaction(async () => {
        await Storage.write(StoragePath.snapshotOwner("home", sessionID), {
          version: 3,
          backend: "shared",
          retentionID: privateID,
        })
        await Storage.remove(StoragePath.snapshotOwner("home", privateID))
      })
      const found: string[] = []
      for await (const root of SnapshotStore.roots("home", sessionID)) found.push(root)
      expect(found.sort()).toEqual(roots.sort())
      const former: string[] = []
      for await (const root of SnapshotStore.roots("home", privateID)) former.push(root)
      expect(former).toEqual([])
      const controller = new AbortController()
      controller.abort(new Error("inventory cancelled"))
      await expect(
        SnapshotStore.roots("home", sessionID, controller.signal)[Symbol.asyncIterator]().next(),
      ).rejects.toThrow("inventory cancelled")
    })
  })
