import { Storage } from "../storage/storage"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotRecords } from "./snapshot-records"
import { SnapshotPortableSource } from "./snapshot-portable-source"
import { SnapshotPortableTarget } from "./snapshot-portable-target"
import { SessionTransferOwners as Owners } from "./transfer-owners"

export namespace SessionTransferSnapshots {
  export const prepared = SnapshotPortableTarget.prepared
  export const retire = SnapshotPortableTarget.retire
  export const discardCancelled = SnapshotPortableSource.discardCancelled

  export function register() {
    Owners.register("session-snapshots", {
      version: 1,
      reads: [1],
      stagedDependencies: ["session-core"],
      async applies(session) {
        if (await SnapshotStore.owner(session.scope.id, session.id)) return true
        for await (const row of Storage.records({
          kind: "part",
          scopeID: session.scope.id,
          sessionID: session.id,
          limit: 128,
        }))
          if (SnapshotRecords.partRoots(row.value).length) return true
        return false
      },
      async inspect(context) {
        const requirements = Owners.compatibility({ "session-core": 1 })
        const owner = await SnapshotStore.owner(context.session.scope.id, context.session.id)
        if (!owner || owner.backend === "deleted")
          requirements.push({
            code: "snapshot_owner_missing",
            owner: "session-snapshots",
            label: "Repair historical Snapshot ownership before handoff",
            recoverable: true,
          })
        return {
          requirements,
          children: (async function* () {
            yield* []
          })(),
        }
      },
      async freeze() {},
      async *export(context) {
        await SnapshotPortableSource.capture(context)
        yield* SnapshotPortableSource.entries(context)
      },
      validate: SnapshotPortableTarget.prepare,
      publish: SnapshotPortableTarget.publish,
    })
  }
}
