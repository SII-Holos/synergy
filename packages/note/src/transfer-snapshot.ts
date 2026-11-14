import { z } from "zod"
import { createHash } from "node:crypto"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import {
  SessionTransferEpochs as Epochs,
  type SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { NoteStore } from "./store"
import { NoteVersions } from "./version-store"

export namespace NoteTransferSnapshots {
  export type Context = Owners.SourceContext & { ownerID?: string }
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Selection = z.strictObject({ noteID: z.string().min(1), version: z.number().int().positive().optional() })
  export type Selection = z.infer<typeof Selection>
  const Ref = z.strictObject({
    version: z.literal(1),
    noteID: z.string(),
    requestedVersion: z.number().int().positive().optional(),
    selectedVersion: z.number().int().positive(),
    sha256: Hash,
    ordinal: z.number().int().nonnegative().safe(),
  })
  const State = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    rootSessionID: z.string(),
    sealed: z.boolean(),
    count: z.number().int().nonnegative().safe().optional(),
    requestHash: Hash.optional(),
    manifestHash: Hash.optional(),
  })
  const Pin = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    selectedVersion: z.number().int().positive(),
  })
  export const Blocked = NamedError.create("NoteTransferSnapshotBlocked", z.object({ message: z.string() }))
  const root = (context: Context) => [
    "note_transfer_snapshots",
    context.session.scope.id,
    context.session.id,
    context.handoffID,
    ...(context.ownerID === undefined ? [] : ["owners", z.string().min(1).parse(context.ownerID)]),
  ]
  const stateKey = (context: Context) => [...root(context), "state"]
  const refKey = (context: Context, ordinal: number) => [...root(context), "refs", String(ordinal).padStart(16, "0")]
  const selectionKey = (context: Context, selection: Selection) => [
    ...root(context),
    "selections",
    selection.noteID,
    selection.version === undefined ? "current" : String(selection.version),
  ]
  const pinKey = (context: Context, selection: Selection) => [
    "note_transfer_pins",
    context.session.scope.id,
    selection.noteID,
    context.session.id,
    context.handoffID,
    ...(context.ownerID === undefined ? [] : ["owners", z.string().min(1).parse(context.ownerID)]),
    selection.version === undefined ? "current" : String(selection.version),
  ]
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  export const documentLock = (scopeID: string, noteID: string) => `note-transfer-document:${scopeID}:${noteID}`

  async function binding(context: Context) {
    context.signal.throwIfAborted()
    const current = await Epochs.ownerPreparationBinding({
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    if (
      current.scopeID !== context.session.scope.id ||
      (current.rootSessionID ?? current.sessionID) !== context.rootSessionID
    )
      throw new Blocked({ message: "Note transfer context is outside its exact source binding" })
    return current
  }
  async function state(context: Context) {
    const current = await binding(context)
    const stored = State.parse(await Storage.read(stateKey(context)))
    if (JSON.stringify(stored.binding) !== JSON.stringify(current) || stored.rootSessionID !== context.rootSessionID)
      throw new Blocked({ message: "Note transfer preparation binding changed" })
    return stored
  }

  export async function seal(context: Context, selections: AsyncIterable<Selection>) {
    const current = await binding(context)
    await Storage.transaction(async () => {
      const [existing] = await Storage.readMany([stateKey(context)])
      if (existing !== undefined) {
        await state(context)
        return
      }
      await Storage.write(
        stateKey(context),
        State.parse({ version: 1, binding: current, rootSessionID: context.rootSessionID, sealed: false }),
      )
    })
    const before = await state(context)
    let count = 0
    const request = createHash("sha256")
    const manifest = createHash("sha256")
    for await (const item of selections) {
      context.signal.throwIfAborted()
      const selection = Selection.parse(item)
      request.update(JSON.stringify(selection) + "\n")
      using lock = await Lock.writeWithSignal(documentLock(current.scopeID, selection.noteID), context.signal)
      const reference = await Storage.transaction(async () => {
        const status = await state(context)
        const [indexed] = await Storage.readMany<number>([selectionKey(context, selection)])
        if (indexed !== undefined) {
          if (indexed !== count)
            throw new Blocked({ message: "Note transfer selections changed or contain duplicates" })
          const ref = Ref.parse(await Storage.read(refKey(context, count)))
          if (ref.noteID !== selection.noteID || ref.requestedVersion !== selection.version)
            throw new Blocked({ message: "Note transfer selected version changed" })
          return ref
        }
        if (status.sealed) throw new Blocked({ message: "A sealed Note transfer cannot select new content" })
        const note = await NoteStore.snapshotForTransfer(current.scopeID, selection.noteID, selection.version)
        await NoteVersions.capture(current.scopeID, note)
        const retained = await NoteVersions.read(current.scopeID, note.id, note.version)
        const ref = Ref.parse({
          version: 1,
          noteID: note.id,
          requestedVersion: selection.version,
          selectedVersion: note.version,
          sha256: hash(retained),
          ordinal: count,
        })
        await Storage.write(refKey(context, count), ref)
        await Storage.write(selectionKey(context, selection), count)
        await Storage.write(
          pinKey(context, selection),
          Pin.parse({ version: 1, binding: current, selectedVersion: note.version }),
        )
        return ref
      })
      manifest.update(JSON.stringify(reference) + "\n")
      count++
    }
    const requestHash = request.digest("hex")
    const manifestHash = manifest.digest("hex")
    let retained = 0
    for await (const _ of Storage.records({ prefix: [...root(context), "refs"], limit: 128 })) retained++
    if (retained !== count)
      throw new Blocked({ message: "Note transfer selections no longer match their retained closure" })
    return Storage.transaction(async () => {
      const currentState = await state(context)
      if (currentState.sealed) {
        if (
          currentState.count !== count ||
          currentState.requestHash !== requestHash ||
          currentState.manifestHash !== manifestHash
        )
          throw new Blocked({ message: "Sealed Note transfer selections changed" })
        return currentState
      }
      if (before.sealed) throw new Blocked({ message: "Note transfer seal was removed" })
      const next = State.parse({ ...currentState, sealed: true, count, requestHash, manifestHash })
      await Storage.write(stateKey(context), next)
      return next
    })
  }

  export async function* read(context: Context) {
    const status = await state(context)
    if (!status.sealed) throw new Blocked({ message: "Note transfer versions are not sealed" })
    let count = 0
    const manifest = createHash("sha256")
    for await (const row of Storage.records({ prefix: [...root(context), "refs"], limit: 128 })) {
      context.signal.throwIfAborted()
      const ref = Ref.parse(row.value)
      if (ref.ordinal !== count) throw new Blocked({ message: "Note transfer version order is incomplete" })
      const note = await NoteVersions.read(status.binding.scopeID, ref.noteID, ref.selectedVersion)
      if (hash(note) !== ref.sha256) throw new Blocked({ message: "Note transfer immutable version checksum changed" })
      manifest.update(JSON.stringify(ref) + "\n")
      count++
      yield { selection: { noteID: ref.noteID, version: ref.requestedVersion }, note }
    }
    if (count !== status.count || manifest.digest("hex") !== status.manifestHash)
      throw new Blocked({ message: "Note transfer retained versions are incomplete" })
  }

  export async function assertDelete(scopeID: string, noteID: string) {
    if (!Storage.inWriteTransaction())
      throw new Blocked({ message: "Note transfer retention requires the document mutation transaction" })
    for await (const row of Storage.records({ prefix: ["note_transfer_pins", scopeID, noteID], limit: 128 })) {
      const pin = Pin.parse(row.value)
      const current = await Epochs.inspect(pin.binding)
      if (["draining", "frozen"].includes(current.phase))
        throw new Blocked({
          message: "An active Session transfer retains this Note version; resolve that transfer before deleting it",
        })
      if (current.role !== "source" || !["cancelled", "surrendered"].includes(current.phase))
        throw new Blocked({ message: "The Note transfer outcome is unresolved" })
      await Storage.remove(row.key)
    }
  }

  export async function* dependencies(context: Context): AsyncGenerator<{ kind: "asset"; reference: string }> {
    for await (const selected of read(context)) {
      const frames: Iterator<unknown>[] = [[selected.note][Symbol.iterator]()]
      while (frames.length) {
        const next = frames.at(-1)!.next()
        if (next.done) {
          frames.pop()
          continue
        }
        if (typeof next.value === "string") {
          const reference = AssetReference.parse(next.value)
          if (reference) yield { kind: "asset", reference: reference.url }
          continue
        }
        if (Array.isArray(next.value)) frames.push(next.value.values())
        else if (next.value && typeof next.value === "object") frames.push(Object.values(next.value).values())
      }
    }
  }
}

export const noteTransferSnapshotMigration: Migration = {
  id: "20261111-note-transfer-snapshots-v1",
  description: "Validate retained Note transfer preparation schemas without altering document bytes",
  scope: "derived",
  execution: "maintenance",
  emptyInput: [["note_transfer_snapshots"]],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["note_transfer_snapshots"], limit: 128 })) {
      if (row.key.at(-1) === "state") {
        const state = z
          .object({ version: z.literal(1), binding: Epochs.Binding, rootSessionID: z.string(), sealed: z.boolean() })
          .passthrough()
          .parse(row.value)
        if ((state.binding.rootSessionID ?? state.binding.sessionID) !== state.rootSessionID)
          throw new Error("Retained Note transfer root binding is invalid")
      }
      progress(++count, 0)
    }
    progress(count, count)
  },
}
