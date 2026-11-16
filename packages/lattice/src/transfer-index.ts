import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { LatticeTypes } from "./lattice/types"

export namespace LatticeTransferIndex {
  const root = (scopeID: string, sessionID: string) => ["lattice_transfer_refs", scopeID, sessionID]
  export function* bindings(run: LatticeTypes.Run) {
    for (const step of run.pathway) {
      if (step.blueprint) yield step.blueprint
      yield* step.blueprintHistory
    }
  }
  export function* loops(run: LatticeTypes.Run) {
    for (const step of run.pathway) for (const attempt of step.loopHistory) yield attempt.loopID
    if (run.effect?.kind === "start_blueprint_loop") yield run.effect.loopID
  }
  export async function index(run: LatticeTypes.Run) {
    await Storage.write([...root(run.scopeID, run.sessionID), "runs", run.id], { runID: run.id })
    for (const binding of bindings(run)) {
      await Storage.write([...root(run.scopeID, run.sessionID), "notes-current", binding.noteID], {
        noteID: binding.noteID,
      })
      for (const version of [binding.boundVersion, binding.reviewedVersion]) {
        if (version === undefined) continue
        await Storage.write([...root(run.scopeID, run.sessionID), "notes", binding.noteID, String(version)], {
          noteID: binding.noteID,
          version,
        })
      }
    }
    if (run.effect?.kind === "create_blueprint_loop")
      await Storage.write([...root(run.scopeID, run.sessionID), "notes-current", run.effect.blueprintNoteID], {
        noteID: run.effect.blueprintNoteID,
      })
    if (run.effect?.kind === "create_blueprint_loop")
      await Storage.write(
        [...root(run.scopeID, run.sessionID), "notes", run.effect.blueprintNoteID, String(run.effect.blueprintVersion)],
        { noteID: run.effect.blueprintNoteID, version: run.effect.blueprintVersion },
      )
    for (const loopID of loops(run))
      await Storage.write([...root(run.scopeID, run.sessionID), "loops", loopID], { loopID })
  }
  export async function* runs(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: [...root(scopeID, sessionID), "runs"], limit: 128 }))
      yield z.strictObject({ runID: z.string() }).parse(row.value).runID
  }
  export async function* notes(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: [...root(scopeID, sessionID), "notes"], limit: 128 }))
      yield z.strictObject({ noteID: z.string(), version: z.number().int().nonnegative() }).parse(row.value)
  }
  export async function* currentNotes(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: [...root(scopeID, sessionID), "notes-current"], limit: 128 }))
      yield z.strictObject({ noteID: z.string() }).parse(row.value).noteID
  }
  export async function* loopIDs(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: [...root(scopeID, sessionID), "loops"], limit: 128 }))
      yield z.strictObject({ loopID: z.string() }).parse(row.value).loopID
  }
}

export const latticeTransferIndexMigration: Migration = {
  id: "20261111-lattice-transfer-references-v1",
  description: "Index retained native Lattice run and document references for bounded handoff",
  scope: "derived",
  execution: "startup",
  emptyInput: [["lattice", "runs"]],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["lattice", "runs"], limit: 128 })) {
      if (row.key.length !== 4) continue
      const parsed = LatticeTypes.Run.safeParse(row.value)
      if (parsed.success) await Storage.transaction(() => LatticeTransferIndex.index(parsed.data))
      else {
        const identity = z
          .object({ id: z.string(), scopeID: z.string(), sessionID: z.string(), schemaVersion: z.number() })
          .safeParse(row.value)
        if (
          !identity.success ||
          identity.data.schemaVersion === 1 ||
          identity.data.id !== row.key[3] ||
          identity.data.scopeID !== row.key[2]
        )
          continue
        await Storage.write(
          ["lattice_transfer_refs", identity.data.scopeID, identity.data.sessionID, "runs", identity.data.id],
          { runID: identity.data.id },
        )
      }
      progress(++count, 0)
    }
    progress(count, count)
  },
}
const migrations = [latticeTransferIndexMigration]
export function registerLatticeTransferMigrations() {
  MigrationRegistry.register("lattice-transfer", migrations)
}
