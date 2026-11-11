import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import type { Info as Loop } from "./blueprint/types"
import type { SuperPlanTypes } from "./superplan/types"

export namespace BlueprintTransferIndex {
  const Ref = z.strictObject({ kind: z.enum(["loop", "plan"]), id: z.string().min(1) })
  export type Ref = z.infer<typeof Ref>
  const key = (scopeID: string, sessionID: string, ref: Ref) => [
    "blueprint_transfer_refs",
    scopeID,
    sessionID,
    ref.kind,
    ref.id,
  ]
  const notesRoot = (scopeID: string, sessionID: string) => ["blueprint_transfer_notes", scopeID, sessionID]
  export const loopSessions = (loop: Pick<Loop, "sessionID" | "auditSessionID" | "parentSessionID">) => [
    ...new Set([loop.sessionID, loop.auditSessionID, loop.parentSessionID].filter((id): id is string => !!id)),
  ]
  export const planSessions = (run: SuperPlanTypes.Run) => [
    ...new Set(
      [
        run.plannerSessionID,
        run.summarySessionID,
        ...run.nodes.map((node) => node.sessionID),
        ...run.merges.map((merge) => merge.sessionID),
      ].filter((id): id is string => !!id),
    ),
  ]
  export const planAnchor = (run: SuperPlanTypes.Run) =>
    run.plannerSessionID ?? run.summarySessionID ?? planSessions(run).sort()[0]

  async function link(scopeID: string, ref: Ref, sessions: readonly string[], previous: readonly string[]) {
    for (const sessionID of previous)
      if (!sessions.includes(sessionID)) await Storage.remove(key(scopeID, sessionID, ref))
    for (const sessionID of sessions) await Storage.write(key(scopeID, sessionID, ref), ref)
  }
  async function note(scopeID: string, anchor: string, noteID: string, version?: number) {
    await Storage.write([...notesRoot(scopeID, anchor), "current", noteID], { noteID })
    if (version !== undefined)
      await Storage.write([...notesRoot(scopeID, anchor), "versions", noteID, String(version)], { noteID, version })
  }
  export async function loop(loop: Loop, previous?: Loop) {
    await link(loop.scopeID, { kind: "loop", id: loop.id }, loopSessions(loop), previous ? loopSessions(previous) : [])
    await note(loop.scopeID, loop.sessionID, loop.noteID, loop.noteVersion)
  }
  export async function plan(run: SuperPlanTypes.Run, previous?: SuperPlanTypes.Run) {
    await link(run.scopeID, { kind: "plan", id: run.id }, planSessions(run), previous ? planSessions(previous) : [])
    const anchor = planAnchor(run)
    if (anchor)
      for (const node of run.nodes) if (node.blueprintNoteID) await note(run.scopeID, anchor, node.blueprintNoteID)
  }
  export async function* refs(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: ["blueprint_transfer_refs", scopeID, sessionID], limit: 128 }))
      yield Ref.parse(row.value)
  }
  export async function* notes(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: notesRoot(scopeID, sessionID), limit: 128 }))
      yield z.strictObject({ noteID: z.string(), version: z.number().int().positive().optional() }).parse(row.value)
  }
}

const migration: Migration = {
  id: "20261111-blueprint-transfer-references-v1",
  scope: "derived",
  execution: "startup",
  emptyInput: [["blueprint_loops"], ["superplan", "runs"]],
  description: "Index native Blueprint and SuperPlan references for bounded lossless handoff",
  async up(progress) {
    let count = 0
    for await (const row of Storage.records<Loop>({ prefix: ["blueprint_loops"], limit: 128 })) {
      if (row.key.length !== 3) continue
      await Storage.transaction(async () => {
        const [current] = await Storage.readMany<Loop>([row.key])
        if (current) await BlueprintTransferIndex.loop(current)
      })
      progress(++count, 0)
    }
    for await (const row of Storage.records<SuperPlanTypes.Run>({ prefix: ["superplan", "runs"], limit: 128 })) {
      if (row.key.length !== 4) continue
      await Storage.transaction(async () => {
        const [current] = await Storage.readMany<SuperPlanTypes.Run>([row.key])
        if (current) await BlueprintTransferIndex.plan(current)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
const migrations = [migration]
export const blueprintTransferIndexMigration = migration
export function registerBlueprintTransferMigrations() {
  MigrationRegistry.register("blueprint-transfer", migrations)
}
