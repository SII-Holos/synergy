import { z } from "zod"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Session } from "@ericsanchezok/synergy-harness/session"
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
import { BlueprintTransferIndex as Index } from "./transfer-index"
import { BlueprintTransferRecords as Records } from "./transfer-records"
import { Info as LoopInfo } from "./blueprint/types"
import { SuperPlanTypes } from "./superplan/types"
import { BlueprintLoopSources } from "./blueprint/source"
import { BlueprintLoopStore } from "./blueprint/loop-store"

const Proof = z.strictObject({
  version: z.literal(1),
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  binding: z.record(z.string(), z.unknown()),
})
const proofKey = (session: Readonly<Session.Info>) => ["blueprint-transfer", session.id]
const binding = (session: Readonly<Session.Info>) => ({
  ...(session.blueprint ? { blueprint: session.blueprint } : {}),
  ...(session.superplan ? { superplan: session.superplan } : {}),
  ...(session.workflow?.kind === "plan" ? { workflow: session.workflow } : {}),
})
const raw = (key: string[], value: unknown) => JSON.stringify([key, value]) + "\n"

async function validateEntry(context: Owners.TargetContext, key: string[], value: unknown) {
  const scopeID = context.session.scope.id
  if (key[0] === "blueprint-transfer-link" && key.length === 4 && key[1] === context.session.id) {
    const link = Records.Link.parse(value)
    if (link.id !== key[3] || link.kind !== key[2])
      throw new Owners.Rejected({ message: "Blueprint transfer link identity changed" })
    const data =
      link.kind === "loop"
        ? LoopInfo.passthrough().parse(link.record)
        : SuperPlanTypes.Run.passthrough().parse(link.record)
    const sessions =
      link.kind === "loop"
        ? Index.loopSessions(LoopInfo.parse(data))
        : Index.planSessions(SuperPlanTypes.Run.parse(data))
    if (data.scopeID !== scopeID || !sessions.includes(context.session.id) || !sessions.includes(link.anchor))
      throw new Owners.Rejected({ message: "Blueprint transfer link has foreign Session ownership" })
    return
  }
  if (key[0] === "blueprint_loops" && key.length === 3 && key[1] === scopeID) {
    const loop = LoopInfo.passthrough().parse(value)
    if (
      loop.id !== key[2] ||
      loop.scopeID !== scopeID ||
      loop.sessionID !== context.session.id ||
      !BlueprintLoopSources.available(loop.source)
    )
      throw new Owners.Rejected({ message: "Blueprint transfer contains a foreign or unavailable loop" })
    if (loop.pluginOwner)
      throw new Owners.Rejected({ message: "Blueprint transfer requires the exact plugin generation owner" })
    const noteKey = Records.noteKey(context.session, loop.noteID, loop.noteVersion)
    const note = await context.staged.record(noteKey)
    if (!note || NoteTypes.Info.parse(note.value).id !== loop.noteID)
      throw new Owners.Rejected({ message: "Blueprint transfer is missing its exact document version" })
    return
  }
  if (key[0] === "superplan" && key[1] === "runs" && key.length === 4 && key[2] === scopeID) {
    const run = SuperPlanTypes.Run.passthrough().parse(value)
    if (run.id !== key[3] || run.scopeID !== scopeID || Index.planAnchor(run) !== context.session.id)
      throw new Owners.Rejected({ message: "SuperPlan transfer contains a foreign native run" })
    for (const node of run.nodes)
      if (
        node.blueprintNoteID &&
        !(await context.staged.record(Records.noteKey(context.session, node.blueprintNoteID)))
      )
        throw new Owners.Rejected({ message: "SuperPlan transfer is missing its referenced document" })
    return
  }
  if (key[0] === "superplan" && key[1] === "events" && key.length === 5 && key[2] === scopeID) {
    const event = SuperPlanTypes.EventInfo.passthrough().parse(value)
    if (
      event.id !== key[4] ||
      event.runID !== key[3] ||
      event.scopeID !== scopeID ||
      !(await context.staged.record(["superplan", "runs", scopeID, event.runID]))
    )
      throw new Owners.Rejected({ message: "SuperPlan event has no matching native run" })
    return
  }
  if (key[0] === "blueprint-transfer-note" && key[1] === context.session.id && key[2] === scopeID && key.length === 5) {
    const note = NoteTypes.PersistedInfo.parse(value)
    NoteDocumentKinds.require(note)
    if (note.id !== key[3] || (key[4] !== "current" && String(note.version) !== key[4]))
      throw new Owners.Rejected({ message: "Blueprint document version identity changed" })
    return
  }
  throw new Owners.Rejected({ message: "Blueprint transfer contains foreign owner data" })
}

async function validate(context: Owners.TargetContext) {
  let proof: z.infer<typeof Proof> | undefined
  const hash = createHash("sha256")
  let count = 0
  for await (const entry of context.staged.records()) {
    context.signal.throwIfAborted()
    if (isDeepStrictEqual(entry.key, proofKey(context.session))) {
      if (proof) throw new Owners.Rejected({ message: "Duplicate Blueprint transfer proof" })
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
    !isDeepStrictEqual(proof.binding, binding(context.session))
  )
    throw new Owners.Rejected({ message: "Blueprint transfer evidence is incomplete or changed" })
  for await (const _ of context.staged.artifacts())
    throw new Owners.Rejected({ message: "Unexpected Blueprint binary data" })
}

export function registerBlueprintTransferOwner() {
  Owners.register("blueprint", {
    version: 1,
    reads: [1],
    async applies(session) {
      if (session.blueprint || session.superplan || session.workflow?.kind === "plan") return true
      for await (const _ of Index.refs(session.scope.id, session.id)) return true
      return false
    },
    async inspect(context) {
      const requirements: Owners.Requirement[] = []
      for await (const entry of Records.native(context.session))
        if (entry.value.pluginOwner)
          requirements.push({
            code: "blueprint_plugin_generation",
            owner: "plugin-blueprint",
            label: "Install and authorize the exact Blueprint plugin generation",
            recoverable: true,
          })
      for await (const ref of Index.notes(context.session.scope.id, context.session.id)) {
        try {
          await Records.exactNote(context.session.scope.id, ref.noteID, ref.version)
        } catch (error) {
          if (!(error instanceof Storage.NotFoundError)) throw error
          requirements.push({
            code: "blueprint_document_version",
            owner: "note",
            label: "Restore the exact recorded Blueprint document version before handoff",
            recoverable: true,
          })
        }
      }
      return {
        requirements,
        children: (async function* () {
          for await (const entry of Records.native(context.session))
            for (const id of entry.sessions) if (id !== context.session.id) yield id
        })(),
      }
    },
    async freeze(context) {
      for await (const entry of Records.native(context.session))
        if (entry.key[0] === "blueprint_loops")
          await BlueprintLoopStore.suspendForTransfer(context.session.scope.id, String(entry.value.id))
      await NoteTransferSnapshots.seal(
        { ...context, ownerID: "blueprint" },
        Index.notes(context.session.scope.id, context.session.id),
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
            JSON.stringify(Proof.parse({ version: 1, count, digest: hash.digest("hex"), binding: binding(session) })),
          )
        })(),
      }
    },
    dependencies: (context) => NoteTransferSnapshots.dependencies({ ...context, ownerID: "blueprint" }),
    validate,
    async publish(context) {
      await validate(context)
      for await (const entry of context.staged.records()) {
        if (isDeepStrictEqual(entry.key, proofKey(context.session)) || entry.key[0] === "blueprint-transfer-link")
          continue
        if (entry.key[0] === "blueprint-transfer-note" && entry.key[4] === "current") {
          await NoteStore.installTransferred({
            scopeID: context.session.scope.id,
            sessionID: context.session.id,
            handoffID: context.handoffID,
            note: NoteTypes.PersistedInfo.parse(entry.value),
          })
          continue
        }
        if (entry.key[0] === "blueprint-transfer-note") {
          await NoteVersions.capture(context.session.scope.id, NoteTypes.PersistedInfo.parse(entry.value))
          continue
        }
        const [existing] = await Storage.readMany([entry.key])
        if (existing !== undefined && !isDeepStrictEqual(existing, entry.value))
          throw new Owners.Rejected({ message: "Destination native Blueprint ledger conflicts" })
        await Storage.write(entry.key, entry.value)
        if (entry.key[0] === "blueprint_loops") await Index.loop(LoopInfo.parse(entry.value))
        if (entry.key[0] === "superplan" && entry.key[1] === "runs")
          await Index.plan(SuperPlanTypes.Run.parse(entry.value))
      }
    },
    async resume(context) {
      for await (const ref of Index.refs(context.session.scope.id, context.rootSessionID)) {
        const entry = await Records.load(context.session.scope.id, ref)
        if (entry.anchor !== context.rootSessionID || entry.key[0] !== "blueprint_loops") continue
        const resumed = await Epochs.ownerResumeBinding({
          sessionID: entry.anchor,
          rootSessionID: context.rootSessionID,
        })
        if (!resumed) continue
        await BlueprintLoopStore.resumeTransferred(context.session.scope.id, String(entry.value.id))
      }
    },
  })
}
