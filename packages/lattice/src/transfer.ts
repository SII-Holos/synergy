import { z } from "zod"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  NoteStore,
  NoteVersions,
  NoteTransferSnapshots,
  NoteTypes,
  NoteDocumentKinds,
} from "@ericsanchezok/synergy-note"
import {
  SessionTransferOwners as Owners,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { LatticeTypes } from "./lattice/types"
import { LatticeLock } from "./lattice/lock"
import { LatticeModelCalls } from "./lattice/model-calls"
import { LatticeController } from "./lattice/controller"
import { LatticeTransferIndex as Index } from "./transfer-index"
import { LatticeTransferRecords as Records } from "./transfer-records"
import { LatticeLegacyArchive as Archive } from "./lattice/legacy-archive"

const Proof = z.strictObject({
  version: z.literal(1),
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: z.record(z.string(), z.unknown()).optional(),
})
const proofKey = (session: Readonly<Session.Info>) => ["lattice-transfer", session.id]
const raw = (key: string[], value: unknown) => JSON.stringify([key, value]) + "\n"

async function validateEntry(context: Owners.TargetContext, key: string[], value: unknown) {
  const scope = context.session.scope.id
  if (key[0] === "lattice_legacy_archive") {
    Archive.validate(key, value, scope, context.session.id)
    return
  }
  if (key[0] === "lattice" && key[1] === "runs" && key[2] === scope && key.length === 4) {
    const run = LatticeTypes.Run.parse(value)
    if (run.id !== key[3] || run.scopeID !== scope || run.sessionID !== context.session.id)
      throw new Owners.Rejected({ message: "Foreign Lattice native run" })
    for (const binding of Index.bindings(run))
      for (const version of [binding.boundVersion, binding.reviewedVersion])
        if (
          version !== undefined &&
          !(await context.staged.record(Records.noteKey(context.session, binding.noteID, version)))
        )
          throw new Owners.Rejected({ message: "Lattice transfer lacks its exact reviewed document version" })
    if (
      run.effect?.kind === "create_blueprint_loop" &&
      !(await context.staged.record(
        Records.noteKey(context.session, run.effect.blueprintNoteID, run.effect.blueprintVersion),
      ))
    )
      throw new Owners.Rejected({ message: "Lattice pending effect lacks its exact document" })
    return
  }
  if (key[0] === "lattice" && key[1] === "events" && key[2] === scope && key.length === 5) {
    const event = LatticeTypes.EventInfo.parse(value)
    if (
      event.id !== key[4] ||
      event.runID !== key[3] ||
      event.scopeID !== scope ||
      event.sessionID !== context.session.id ||
      !(await context.staged.record(["lattice", "runs", scope, event.runID]))
    )
      throw new Owners.Rejected({ message: "Lattice event lacks its native run" })
    return
  }
  if (isDeepStrictEqual(key, ["lattice", "current", scope, context.session.id])) {
    const pointer = LatticeTypes.CurrentPointer.parse(value)
    if (
      pointer.scopeID !== scope ||
      pointer.sessionID !== context.session.id ||
      !(await context.staged.record(["lattice", "runs", scope, pointer.runID]))
    )
      throw new Owners.Rejected({ message: "Lattice current pointer is incomplete" })
    return
  }
  if (key[0] === "lattice-transfer-note" && key.length === 5 && key[1] === context.session.id && key[2] === scope) {
    const note = NoteTypes.PersistedInfo.parse(value)
    NoteDocumentKinds.require(note)
    if (note.id !== key[3] || (key[4] !== "current" && String(note.version) !== key[4]))
      throw new Owners.Rejected({ message: "Lattice document version identity changed" })
    return
  }
  throw new Owners.Rejected({ message: "Foreign Lattice portability data" })
}
async function validate(context: Owners.TargetContext) {
  const hash = createHash("sha256")
  let count = 0
  let proof: z.infer<typeof Proof> | undefined
  for await (const entry of context.staged.records()) {
    context.signal.throwIfAborted()
    if (isDeepStrictEqual(entry.key, proofKey(context.session))) {
      if (proof) throw new Owners.Rejected({ message: "Duplicated Lattice transfer proof" })
      proof = Proof.parse(entry.value)
      continue
    }
    await validateEntry(context, entry.key, entry.value)
    hash.update(raw(entry.key, entry.value))
    count++
  }
  if (
    !proof ||
    proof.count !== count ||
    proof.digest !== hash.digest("hex") ||
    !isDeepStrictEqual(
      proof.workflow,
      context.session.workflow?.kind === "lattice" ? context.session.workflow : undefined,
    )
  )
    throw new Owners.Rejected({ message: "Lattice transfer evidence changed or is incomplete" })
  const workflow = context.session.workflow
  if (
    workflow?.kind === "lattice" &&
    !(await context.staged.record(["lattice", "runs", context.session.scope.id, workflow.runID]))
  )
    throw new Owners.Rejected({ message: "Lattice workflow lacks its exact native run" })
  for await (const _ of context.staged.artifacts())
    throw new Owners.Rejected({ message: "Unexpected Lattice binary data" })
}

export function registerLatticeTransferOwner() {
  Owners.register("lattice", {
    version: 1,
    reads: [1],
    async applies(session) {
      if (session.workflow?.kind === "lattice") return true
      for await (const _ of Index.runs(session.scope.id, session.id)) return true
      for await (const _ of Archive.records(session.scope.id, session.id)) return true
      return false
    },
    async inspect(context) {
      const requirements: Owners.Requirement[] = []
      const inspectRun = async (runID: string) => {
        try {
          await Records.run(context.session.scope.id, context.session.id, runID)
        } catch (error) {
          if (!(error instanceof Storage.NotFoundError) && !(error instanceof z.ZodError)) throw error
          requirements.push({
            code: "lattice_schema_unavailable",
            owner: "lattice",
            label: "Open the retained native Lattice history with a compatible owner version",
            recoverable: true,
          })
        }
      }
      if (context.session.workflow?.kind === "lattice") await inspectRun(context.session.workflow.runID)
      for await (const runID of Index.runs(context.session.scope.id, context.session.id)) await inspectRun(runID)
      for await (const note of Index.notes(context.session.scope.id, context.session.id)) {
        try {
          await NoteStore.snapshotForTransfer(context.session.scope.id, note.noteID, note.version)
        } catch (error) {
          if (!(error instanceof Storage.NotFoundError) && !(error instanceof z.ZodError)) throw error
          requirements.push({
            code: "lattice_document_version",
            owner: "note",
            label: "Restore the exact recorded Lattice document version",
            recoverable: true,
          })
        }
      }
      return {
        requirements,
        children: (async function* () {
          for await (const loopID of Index.loopIDs(context.session.scope.id, context.session.id)) {
            const loop = await BlueprintLoopStore.getStored(context.session.scope.id, loopID)
            if (loop.sessionID !== context.session.id) yield loop.sessionID
            if (loop.auditSessionID) yield loop.auditSessionID
          }
        })(),
      }
    },
    async freeze(context) {
      using _ = await LatticeLock.write(context.session.scope.id, context.session.id)
      await LatticeModelCalls.flush(context.session.scope.id, context.session.id)
      if (LatticeModelCalls.peek(context.session.id))
        throw new Owners.Rejected({ message: "Lattice model-call evidence has no reconciled native run" })
      await NoteTransferSnapshots.seal(
        { ...context, ownerID: "lattice" },
        (async function* () {
          yield* Index.notes(context.session.scope.id, context.session.id)
          for await (const noteID of Index.currentNotes(context.session.scope.id, context.session.id)) yield { noteID }
        })(),
      )
    },
    async *export(context) {
      const session = await Session.get(context.session.id)
      const hash = createHash("sha256")
      let count = 0
      for await (const entry of Records.entries({ ...context, session })) {
        context.signal.throwIfAborted()
        hash.update(raw(entry.key, entry.value))
        count++
        yield {
          id: JSON.stringify(entry.key),
          kind: "record" as const,
          metadata: { key: entry.key },
          content: (async function* () {
            yield new TextEncoder().encode(JSON.stringify(entry.value))
          })(),
        }
      }
      const key = proofKey(session)
      yield {
        id: JSON.stringify(key),
        kind: "record",
        metadata: { key },
        content: (async function* () {
          yield new TextEncoder().encode(
            JSON.stringify(
              Proof.parse({
                version: 1,
                count,
                digest: hash.digest("hex"),
                workflow: session.workflow?.kind === "lattice" ? session.workflow : undefined,
              }),
            ),
          )
        })(),
      }
    },
    async *dependencies(context) {
      yield* NoteTransferSnapshots.dependencies({ ...context, ownerID: "lattice" })
      yield* Archive.dependencies(context.session.scope.id, context.session.id)
    },
    validate,
    async publish(context) {
      await validate(context)
      for await (const entry of context.staged.records()) {
        if (isDeepStrictEqual(entry.key, proofKey(context.session))) continue
        if (entry.key[0] === "lattice-transfer-note") {
          const note = NoteTypes.PersistedInfo.parse(entry.value)
          if (entry.key[4] === "current")
            await NoteStore.installTransferred({
              scopeID: context.session.scope.id,
              sessionID: context.session.id,
              handoffID: context.handoffID,
              note,
            })
          else await NoteVersions.capture(context.session.scope.id, note)
          continue
        }
        const [existing] = await Storage.readMany([entry.key])
        if (existing !== undefined && !isDeepStrictEqual(existing, entry.value))
          throw new Owners.Rejected({ message: "Destination Lattice ledger conflicts" })
        await Storage.write(entry.key, entry.value)
        if (entry.key[0] === "lattice" && entry.key[1] === "runs")
          await Index.index(LatticeTypes.Run.parse(entry.value))
      }
    },
    async resume(context) {
      for await (const row of Storage.records<Session.Info>({
        kind: "session",
        scopeID: context.session.scope.id,
        limit: 128,
      })) {
        const session = row.value
        if (session.workflow?.kind !== "lattice") continue
        let current = session
        const visited = new Set<string>()
        while (current.id !== context.rootSessionID && current.parentID && !visited.has(current.id)) {
          visited.add(current.id)
          current = await Session.get(current.parentID)
        }
        if (current.id !== context.rootSessionID) continue
        if (!(await Epochs.ownerResumeBinding({ sessionID: session.id, rootSessionID: context.rootSessionID })))
          continue
        await ScopeContext.provide({
          scope: session.scope,
          fn: () => LatticeController.reconcileDirect(session.scope.id, session.id, "resume"),
        })
      }
    },
  })
}
