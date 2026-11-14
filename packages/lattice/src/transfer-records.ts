import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { SessionTransferOwners as Owners } from "@ericsanchezok/synergy-harness/session/transfer"
import type { Session } from "@ericsanchezok/synergy-harness/session"
import { NoteTransferSnapshots } from "@ericsanchezok/synergy-note"
import { LatticeTypes } from "./lattice/types"
import { LatticeTransferIndex as Index } from "./transfer-index"
import { SessionTransferOwners as TransferOwners } from "@ericsanchezok/synergy-harness/session/transfer"
import { LatticeLegacyArchive } from "./lattice/legacy-archive"

export namespace LatticeTransferRecords {
  export const noteKey = (session: Readonly<Session.Info>, noteID: string, version?: number) => [
    "lattice-transfer-note",
    session.id,
    session.scope.id,
    noteID,
    version === undefined ? "current" : String(version),
  ]
  export async function run(scopeID: string, sessionID: string, runID: string) {
    const run = LatticeTypes.Run.parse(await Storage.read(["lattice", "runs", scopeID, runID]))
    if (run.id !== runID || run.scopeID !== scopeID || run.sessionID !== sessionID)
      throw new TransferOwners.Rejected({ message: "Lattice native run identity changed" })
    return run
  }
  export async function* entries(context: Owners.SourceContext) {
    const session = context.session
    for await (const runID of Index.runs(session.scope.id, session.id)) {
      yield { key: ["lattice", "runs", session.scope.id, runID], value: await run(session.scope.id, session.id, runID) }
      for await (const event of Storage.records({ prefix: ["lattice", "events", session.scope.id, runID], limit: 128 }))
        yield { key: event.key, value: LatticeTypes.EventInfo.parse(event.value) }
    }
    const pointerKey = ["lattice", "current", session.scope.id, session.id]
    const [pointer] = await Storage.readMany([pointerKey])
    if (pointer) yield { key: pointerKey, value: LatticeTypes.CurrentPointer.parse(pointer) }
    for await (const selected of NoteTransferSnapshots.read({ ...context, ownerID: "lattice" }))
      yield { key: noteKey(session, selected.note.id, selected.selection.version), value: selected.note }
    yield* LatticeLegacyArchive.records(session.scope.id, session.id)
  }
}
