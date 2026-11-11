import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Session } from "@ericsanchezok/synergy-harness/session"
import { NoteStore, NoteTransferSnapshots, NoteTypes } from "@ericsanchezok/synergy-note"
import { BlueprintTransferIndex as Index } from "./transfer-index"
import { Info as LoopInfo } from "./blueprint/types"
import { SuperPlanTypes } from "./superplan/types"
import { BlueprintLoopSources } from "./blueprint/source"
import { SessionTransferOwners as Owners } from "@ericsanchezok/synergy-harness/session/transfer"

export namespace BlueprintTransferRecords {
  export const Link = z.strictObject({
    version: z.literal(1),
    kind: z.enum(["loop", "plan"]),
    id: z.string(),
    anchor: z.string(),
    record: z.record(z.string(), z.unknown()),
  })
  export type Native = { key: string[]; value: Record<string, unknown>; anchor: string; sessions: string[] }
  export const key = (scopeID: string, ref: Index.Ref) =>
    ref.kind === "loop" ? ["blueprint_loops", scopeID, ref.id] : ["superplan", "runs", scopeID, ref.id]

  export async function load(scopeID: string, ref: Index.Ref): Promise<Native> {
    const path = key(scopeID, ref)
    const raw = z.record(z.string(), z.unknown()).parse(await Storage.read<unknown>(path))
    if (ref.kind === "loop") {
      const loop = LoopInfo.passthrough().parse(raw)
      if (loop.id !== ref.id || loop.scopeID !== scopeID)
        throw new Owners.Rejected({ message: "Blueprint ledger identity is inconsistent" })
      if (!BlueprintLoopSources.available(loop.source))
        throw new Owners.Rejected({
          message: "Blueprint loop source is unavailable",
          requirements: [
            {
              code: "blueprint_source",
              owner: loop.source,
              label: "Install the recorded Blueprint loop source",
              recoverable: true,
            },
          ],
        })
      return { key: path, value: raw, anchor: loop.sessionID, sessions: Index.loopSessions(loop) }
    }
    const run = SuperPlanTypes.Run.passthrough().parse(raw)
    const anchor = Index.planAnchor(run)
    if (!anchor || run.id !== ref.id || run.scopeID !== scopeID)
      throw new Owners.Rejected({ message: "SuperPlan ledger identity is inconsistent" })
    return { key: path, value: raw, anchor, sessions: Index.planSessions(run) }
  }

  export const noteKey = (session: Readonly<Session.Info>, noteID: string, version?: number) => [
    "blueprint-transfer-note",
    session.id,
    session.scope.id,
    noteID,
    version === undefined ? "current" : String(version),
  ]

  export async function exactNote(scopeID: string, noteID: string, version?: number) {
    return NoteStore.snapshotForTransfer(scopeID, noteID, version)
  }

  export async function* native(session: Readonly<Session.Info>) {
    for await (const ref of Index.refs(session.scope.id, session.id)) {
      const entry = await load(session.scope.id, ref)
      if (!entry.sessions.includes(session.id))
        throw new Owners.Rejected({ message: "Blueprint transfer reference disagrees with its native ledger" })
      yield entry
    }
  }

  export async function* entries(context: Owners.SourceContext) {
    const session = context.session
    for await (const entry of native(session)) {
      if (entry.anchor !== session.id) {
        const kind = entry.key[0] === "blueprint_loops" ? "loop" : "plan"
        yield {
          key: ["blueprint-transfer-link", session.id, kind, String(entry.value.id)],
          value: Link.parse({ version: 1, kind, id: entry.value.id, anchor: entry.anchor, record: entry.value }),
        }
        continue
      }
      yield { key: entry.key, value: entry.value }
      if (entry.key[0] === "superplan") {
        for await (const event of Storage.records({
          prefix: ["superplan", "events", session.scope.id, String(entry.value.id)],
          limit: 128,
        }))
          yield { key: event.key, value: z.record(z.string(), z.unknown()).parse(event.value) }
      }
    }
    for await (const selected of NoteTransferSnapshots.read(context)) {
      yield { key: noteKey(session, selected.note.id, selected.selection.version), value: selected.note }
    }
  }
}
