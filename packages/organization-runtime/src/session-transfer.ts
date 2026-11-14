import { z } from "zod"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { isDeepStrictEqual } from "node:util"
import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationCommandRecords as Records } from "./command-records"
import { OrganizationIntakePath as Keys } from "./storage/path"
import { OrganizationSessionAdoption as Adoption } from "./session-adoption"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { drainMemberSync } from "./sync-exporter"
import { drainMemberFiles } from "./execution-source"

export namespace OrganizationSessionTransfer {
  export const id = "organization-runtime"
  export const version = 5
  const ID = z.string().min(1)
  const Count = z.number().int().nonnegative().safe()
  const LegacyHeader = z.strictObject({
    version: z.literal(3),
    capabilities: z.strictObject({
      adoption: z.literal(1),
      commandClosure: z.literal(1),
      executionContinuation: z.literal(1),
      corePublication: z.literal(1),
    }),
    handoffID: ID,
    rootSessionID: ID,
    sessionID: ID,
    sourceBinding: OrganizationProtocol.SessionBinding,
    commandSeq: Count,
    records: Count,
  })
  const ReceiptHeader = LegacyHeader.extend({
    version: z.literal(4),
    workspaceMoveReceipt: WorkspaceMove.Receipt.nullable(),
  })
  const CurrentHeader = ReceiptHeader.extend({
    version: z.literal(5),
    workspaceSourceSnapshot: WorkspaceArchive.Subtree.nullable(),
  })
  const Header = z.union([LegacyHeader, ReceiptHeader, CurrentHeader])
  const sourceKey = (binding: Epochs.Binding) => [
    "organization-session-transfer",
    binding.handoffID,
    binding.sessionID,
    "workspace-source",
  ]
  const WorkspaceSource = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    snapshot: WorkspaceArchive.Subtree,
  })
  export async function workspaceSource(value: Epochs.Binding) {
    const binding = Epochs.Binding.parse(value)
    const [raw] = await Storage.readMany([sourceKey(binding)])
    if (raw === undefined) return null
    const retained = WorkspaceSource.parse(raw)
    if (!same(retained.binding, binding)) fail("Workspace source belongs to another exact aggregate")
    return retained.snapshot
  }
  export async function retainWorkspaceSource(
    value: Epochs.Binding,
    snapshot: WorkspaceArchive.Subtree,
    signal: AbortSignal,
  ) {
    const binding = Epochs.Binding.parse(value)
    const selected = WorkspaceArchive.Subtree.parse(snapshot)
    const assert = WorkspaceContent.captureOwner(signal)
    await Storage.transaction(
      async () => {
        const actual = await Epochs.ownerPreparationBinding({
          sessionID: binding.sessionID,
          handoffID: binding.handoffID,
        })
        if (!same(actual, binding)) fail("Workspace source epoch changed")
        const previous = await workspaceSource(binding)
        if (previous && !same(previous, selected)) fail("Workspace source cannot replace its captured service head")
        if (!previous)
          await Storage.write(sourceKey(binding), WorkspaceSource.parse({ version: 1, binding, snapshot: selected }))
        assert()
      },
      { commitGuard: assert },
    )
  }
  const moveKey = (handoffID: string, sessionID: string) => [
    "organization-session-transfer",
    ID.parse(handoffID),
    ID.parse(sessionID),
    "workspace-move",
  ]
  const Move = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    source: WorkspaceMove.CapturedSource,
    receipt: WorkspaceMove.Receipt.optional(),
  })
  export async function workspaceMoveSource(value: Epochs.Binding) {
    const binding = Epochs.Binding.parse(value)
    const [raw] = await Storage.readMany([moveKey(binding.handoffID, binding.sessionID)])
    if (raw === undefined) return
    const stored = Move.parse(raw)
    if (!same(stored.binding, binding)) fail("Workspace move belongs to another source aggregate")
    return stored
  }
  export async function workspaceMove(value: Epochs.Binding) {
    return (await workspaceMoveSource(value))?.receipt ?? null
  }
  export async function retainWorkspaceMoveSource(
    value: Epochs.Binding,
    source: z.infer<typeof WorkspaceMove.CapturedSource>,
    signal: AbortSignal,
  ) {
    const binding = Epochs.Binding.parse(value)
    const selected = WorkspaceMove.CapturedSource.parse(source)
    const assert = WorkspaceContent.captureOwner(signal)
    await Storage.transaction(
      async () => {
        const actual = await Epochs.ownerPreparationBinding({
          sessionID: binding.sessionID,
          handoffID: binding.handoffID,
        })
        if (!same(actual, binding) || selected.scopeID !== binding.scopeID)
          fail("Workspace dispatch has another source aggregate")
        const previous = await workspaceMoveSource(binding)
        if (previous && !same(previous.source, selected)) fail("Workspace dispatch cannot replace its original source")
        if (!previous)
          await Storage.write(
            moveKey(binding.handoffID, binding.sessionID),
            Move.parse({ version: 1, binding, source: selected }),
          )
        assert()
      },
      { commitGuard: assert },
    )
  }
  export async function retainWorkspaceMove(
    value: Epochs.Binding,
    receipt: WorkspaceMove.Receipt,
    signal: AbortSignal,
  ) {
    const binding = Epochs.Binding.parse(value)
    const selected = WorkspaceMove.Receipt.parse(receipt)
    const assert = WorkspaceContent.captureOwner(signal)
    if (
      (binding.rootSessionID ?? binding.sessionID) !== binding.sessionID ||
      selected.source.scopeID !== binding.scopeID
    )
      fail("Workspace move requires its canonical source aggregate")
    await Storage.transaction(
      async () => {
        const actual = await Epochs.ownerPreparationBinding({
          sessionID: binding.sessionID,
          handoffID: binding.handoffID,
        })
        if (!same(actual, binding)) fail("Workspace move source epoch changed")
        const previous = await workspaceMoveSource(binding)
        if (!previous || !same(previous.source, selected.source)) fail("Workspace move has another dispatched source")
        if (previous.receipt && !same(previous.receipt, selected))
          fail("Workspace move cannot replace its original receipt")
        await Storage.write(
          moveKey(binding.handoffID, binding.sessionID),
          Move.parse({ ...previous, receipt: selected }),
        )
        assert()
      },
      { commitGuard: assert },
    )
  }
  const Row = z.strictObject({ key: z.array(ID).min(1), value: z.unknown() })
  const headerKey = (context: Pick<Owners.SourceContext, "handoffID" | "session">) => [
    "organization-session-transfer",
    context.handoffID,
    context.session.id,
    "header",
  ]
  const prefix = (header: z.infer<typeof Header>) => Keys.sessionRecords(header.sourceBinding.orgID, header.sessionID)
  const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b)
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  function tag<K extends string, V>(kind: K, value: V) {
    return { kind, value }
  }
  function permit(value: Command.Permit, header: z.infer<typeof Header>) {
    if (
      value.orgID !== header.sourceBinding.orgID ||
      value.projectID !== header.sourceBinding.projectID ||
      value.sessionID !== header.sessionID ||
      value.commandSeq > header.commandSeq ||
      value.actor.orgID !== value.orgID ||
      value.actor.requestID !== value.requestID
    )
      fail("Portable command permit exceeds its closed organization Session watermark")
  }
  function classify(row: Owners.StagedRecord, header: z.infer<typeof Header>) {
    const orgID = header.sourceBinding.orgID
    const root = prefix(header)
    if (root.every((part, index) => row.key[index] === part)) {
      const tail = row.key.slice(root.length)
      if (tail.length === 1 && tail[0] === "state") {
        const value = Records.State.parse(row.value)
        if (
          value.orgID !== orgID ||
          value.projectID !== header.sourceBinding.projectID ||
          value.sessionID !== header.sessionID ||
          value.runtimeID !== header.sourceBinding.driverRuntimeID ||
          value.bindingEpoch !== header.sourceBinding.bindingEpoch ||
          value.commandSeq !== header.commandSeq
        )
          fail("Portable command checkpoint has another native binding")
        return tag("state", value)
      }
      if (tail.length === 1 && tail[0] === "control") return tag("control", Records.ControlState.parse(row.value))
      if (tail.length === 2 && tail[0] === "attempts") {
        const value = Command.Attempt.parse(row.value)
        permit(value.permit, header)
        if (tail[1] !== value.permit.attemptID) fail("Portable command attempt key changed")
        return tag("attempt", value)
      }
      if (tail.length === 2 && tail[0] === "skips") {
        const value = Command.SkipReceipt.parse(row.value)
        permit(value.permit.command, header)
        if (tail[1] !== value.permit.command.attemptID) fail("Portable command skip key changed")
        return tag("skip", value)
      }
      if (tail.length === 2 && tail[0] === "commands") {
        const value = Records.Slot.parse(row.value)
        const sequence = Number(tail[1])
        if (
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          sequence > header.commandSeq ||
          String(sequence).padStart(16, "0") !== tail[1]
        )
          fail("Portable command slot is outside its closed watermark")
        return tag("slot", { ...value, commandSeq: sequence })
      }
      if (tail.length === 3 && tail[0] === "requests") {
        const value = Records.SessionRequest.parse(row.value)
        if (value.subjectID !== tail[1] || value.requestID !== tail[2]) fail("Portable request index identity changed")
        return tag("index", value)
      }
    }
    if (row.key[0] === "organization-command" && row.key[1] === orgID && row.key[2] === "requests") {
      const value = Records.Request.parse(row.value)
      if (
        value.identity.orgID !== orgID ||
        value.identity.projectID !== header.sourceBinding.projectID ||
        value.identity.sessionID !== header.sessionID ||
        !same(row.key, Keys.request(orgID, value.identity.subjectID, value.identity.requestID))
      )
        fail("Portable request identity belongs to another Session")
      if (value.accepted) permit(value.accepted.permit, header)
      return tag("request", value)
    }
    if (row.key[0] === "organization-command" && row.key[1] === orgID && row.key[2] === "releases") {
      const value = Records.Release.parse(row.value)
      if (
        value.orgID !== orgID ||
        value.projectID !== header.sourceBinding.projectID ||
        value.sessionID !== header.sessionID ||
        value.actor.subjectID !== value.subjectID ||
        value.actor.requestID !== value.requestID ||
        value.actor.orgID !== orgID ||
        !same(row.key, Keys.release(orgID, value.subjectID, value.requestID))
      )
        fail("Portable release identity belongs to another Session")
      return tag("release", value)
    }
    fail("Portable commands contain another owner's storage key")
  }
  function current(session: Readonly<Session.Info>) {
    return OrganizationProtocol.SessionBinding.parse(session.organization)
  }
  function sourceHeader(
    context: Owners.SourceContext,
    value: unknown,
    receipt: WorkspaceMove.Receipt | null = null,
    snapshot: WorkspaceArchive.Subtree | null = null,
  ) {
    return CurrentHeader.parse({
      version: 5,
      capabilities: { adoption: 1, commandClosure: 1, executionContinuation: 1, corePublication: 1 },
      handoffID: context.handoffID,
      rootSessionID: context.rootSessionID,
      sessionID: context.session.id,
      sourceBinding: current(context.session),
      commandSeq: value === undefined ? 0 : Records.State.parse(value).commandSeq,
      records: 0,
      workspaceMoveReceipt: receipt,
      workspaceSourceSnapshot: snapshot,
    })
  }
  async function closedPosition(
    header: z.infer<typeof Header>,
    value: Command.Permit,
    exact: boolean,
    read: (key: string[]) => Promise<Owners.StagedRecord | undefined>,
  ) {
    const slot = await read(Keys.slot(header.sourceBinding.orgID, header.sessionID, value.commandSeq))
    if (!slot) fail("Portable command attempt has no closed slot")
    const parsed = classify(slot, header)
    if (parsed.kind !== "slot" || (exact && parsed.value.attemptID !== value.attemptID))
      fail("Portable command reception does not own its closed slot")
  }
  const json = (value: unknown) =>
    (async function* () {
      yield new TextEncoder().encode(JSON.stringify(value))
    })()

  async function* entries(context: Owners.SourceContext) {
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const binding = current(context.session)
    const base = path.join(Global.Path.cache, "organization-session-transfer")
    await fs.mkdir(base, { recursive: true })
    const directory = await fs.mkdtemp(path.join(base, "capture-"))
    try {
      const filename = path.join(directory, "records.ndjson")
      let records = 0
      const state = await Storage.snapshot(async () => {
        const [value] = await Storage.readMany([Keys.state(binding.orgID, context.session.id)])
        const header = sourceHeader(
          context,
          value,
          context.session.id === context.rootSessionID
            ? await workspaceMove(
                await Epochs.ownerPreparationBinding({ sessionID: context.session.id, handoffID: context.handoffID }),
              )
            : null,
          context.session.id === context.rootSessionID
            ? await workspaceSource(
                await Epochs.ownerPreparationBinding({ sessionID: context.session.id, handoffID: context.handoffID }),
              )
            : null,
        )
        const file = await fs.open(filename, "wx", 0o600)
        try {
          for await (const row of Storage.records({ prefix: prefix(header), limit: 128 })) {
            context.signal.throwIfAborted()
            const parsed = classify(row, header)
            await file.writeFile(JSON.stringify({ key: row.key, value: row.value }) + "\n")
            records++
            if (parsed.kind !== "index") continue
            const requestKey = Keys.request(binding.orgID, parsed.value.subjectID, parsed.value.requestID)
            const releaseKey = Keys.release(binding.orgID, parsed.value.subjectID, parsed.value.requestID)
            const [request, release] = await Storage.readMany([requestKey, releaseKey])
            if (request === undefined) fail("Portable request index has no canonical request")
            for (const related of [
              { key: requestKey, value: request },
              ...(release === undefined ? [] : [{ key: releaseKey, value: release }]),
            ]) {
              classify(related, header)
              await file.writeFile(JSON.stringify(related) + "\n")
              records++
            }
          }
        } finally {
          await file.close()
        }
        return Header.parse({ ...header, records })
      })
      yield {
        id: JSON.stringify(headerKey(context)),
        kind: "record" as const,
        metadata: { key: headerKey(context) },
        content: json(state),
      }
      const stream = createReadStream(filename, { encoding: "utf8", signal: context.signal })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          context.signal.throwIfAborted()
          const row = Row.parse(JSON.parse(line))
          yield {
            id: JSON.stringify([id, row.key]),
            kind: "record" as const,
            metadata: { key: row.key },
            content: json(row.value),
          }
        }
        context.signal.throwIfAborted()
      } finally {
        lines.close()
        stream.destroy()
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }

  const prepared = new WeakMap<
    Owners.TargetContext,
    { runtime: RuntimeContext.Instance; header: z.infer<typeof Header> }
  >()
  export async function stagedWorkspaceMove(context: Owners.TargetContext) {
    const row = await context.staged.record(headerKey(context))
    const header = Header.parse(row?.value)
    if (
      header.version !== context.sourceVersion ||
      header.handoffID !== context.handoffID ||
      header.sessionID !== context.session.id ||
      header.rootSessionID !== context.rootSessionID ||
      !same(header.sourceBinding, current(context.session))
    )
      fail("Workspace receipt has another source header")
    return header.version >= 4 && "workspaceMoveReceipt" in header ? header.workspaceMoveReceipt : null
  }
  export async function stagedWorkspaceSource(context: Owners.TargetContext) {
    await stagedWorkspaceMove(context)
    const row = await context.staged.record(headerKey(context))
    const header = Header.parse(row?.value)
    return header.version === 5 ? header.workspaceSourceSnapshot : null
  }
  async function validate(context: Owners.TargetContext) {
    const row = await context.staged.record(headerKey(context))
    if (!row) fail("Portable organization owner proof is missing")
    const header = Header.parse(row.value)
    if (header.version !== context.sourceVersion) fail("Portable organization header has another reader version")
    const move = header.version !== 3 ? header.workspaceMoveReceipt : null
    const expectedMove = context.mapping.workspaceMoveReceiptHash ?? null
    if (
      (move ? WorkspaceMove.receiptHash(move) : null) !== expectedMove ||
      (move && (header.sessionID !== header.rootSessionID || move.source.scopeID !== header.sourceBinding.projectID))
    )
      fail("Portable organization header has another complete WorkspaceMove receipt")
    const snapshot = header.version === 5 ? header.workspaceSourceSnapshot : null
    if (
      (snapshot ? WorkspaceArchive.subtreeHash(snapshot) : null) !== (context.mapping.workspaceSourceHash ?? null) ||
      (snapshot && (move || header.sessionID !== header.rootSessionID))
    )
      fail("Portable organization header has another complete Workspace source snapshot")
    const core = await context.staged.relatedRecord?.("session-core", [
      "sessions",
      context.session.scope.id,
      context.session.id,
      "info",
    ])
    const coreInfo =
      core &&
      z
        .object({
          id: ID,
          parentID: ID.optional(),
          scope: z.object({ type: z.literal("project"), id: ID }),
          organization: OrganizationProtocol.SessionBinding,
        })
        .parse(core.value)
    if (
      !coreInfo ||
      coreInfo.id !== context.session.id ||
      coreInfo.parentID !== context.session.parentID ||
      coreInfo.scope.id !== context.session.scope.id ||
      !same(coreInfo.organization, header.sourceBinding)
    )
      fail("Portable organization proof does not match its canonical Core binding")
    if (
      header.handoffID !== context.handoffID ||
      header.rootSessionID !== context.rootSessionID ||
      header.sessionID !== context.session.id ||
      !same(header.sourceBinding, current(context.session)) ||
      header.sourceBinding.projectID !== context.session.scope.id
    )
      fail("Portable organization owner proof has another Session binding")
    const requireRecord = async (key: string[]) => {
      const record = await context.staged.record(key)
      if (!record) fail("Portable organization command dependency is missing")
      return classify(record, header)
    }
    const orgID = header.sourceBinding.orgID
    let records = 0
    let slots = 0
    let checkpoints = 0
    let headers = 0
    for await (const entry of context.staged.records()) {
      context.signal.throwIfAborted()
      if (same(entry.key, headerKey(context))) {
        headers++
        continue
      }
      const parsed = classify(entry, header)
      records++
      if (parsed.kind === "state") checkpoints++
      if (parsed.kind === "slot") {
        slots++
        const attempt = await requireRecord(Keys.attempt(orgID, header.sessionID, parsed.value.attemptID))
        if (attempt.kind !== "attempt" || attempt.value.permit.commandSeq !== parsed.value.commandSeq)
          fail("Portable command slot does not match its native attempt")
      }
      if (parsed.kind === "index") {
        const request = await requireRecord(Keys.request(orgID, parsed.value.subjectID, parsed.value.requestID))
        if (request.kind !== "request") fail("Portable request index has another dependency kind")
      }
      if (parsed.kind === "request") {
        await requireRecord(
          Keys.sessionRequest(
            orgID,
            header.sessionID,
            parsed.value.identity.subjectID,
            parsed.value.identity.requestID,
          ),
        )
        const accepted = parsed.value.accepted
        if (accepted) {
          const attempt = await requireRecord(Keys.attempt(orgID, header.sessionID, accepted.permit.attemptID))
          if (
            attempt.kind !== "attempt" ||
            attempt.value.status !== "accepted" ||
            attempt.value.acceptedAttemptID !== accepted.permit.attemptID ||
            !same(attempt.value.permit, accepted.permit)
          )
            fail("Portable accepted request has no matching reception evidence")
          if (accepted.effect.kind === "inbox" && accepted.effect.mode === "task" && accepted.permit.provisionalGrantID)
            await requireRecord(Keys.release(orgID, accepted.permit.actor.subjectID, accepted.permit.requestID))
        }
      }
      if (parsed.kind === "attempt") {
        await closedPosition(header, parsed.value.permit, parsed.value.status !== "rejected", context.staged.record)
        const request = await requireRecord(
          Keys.request(orgID, parsed.value.permit.actor.subjectID, parsed.value.permit.requestID),
        )
        if (
          parsed.value.status === "accepted" &&
          (request.kind !== "request" || request.value.accepted?.permit.attemptID !== parsed.value.acceptedAttemptID)
        )
          fail("Portable accepted attempt does not match its original request")
        if (parsed.value.status === "skipped")
          await requireRecord(Keys.skip(orgID, header.sessionID, parsed.value.permit.attemptID))
      }
      if (parsed.kind === "skip") {
        await closedPosition(header, parsed.value.permit.command, true, context.staged.record)
        const attempt = await requireRecord(
          Keys.attempt(orgID, header.sessionID, parsed.value.permit.command.attemptID),
        )
        if (attempt.kind !== "attempt" || !same(attempt.value.permit, parsed.value.permit.command))
          fail("Portable skip does not match its original attempt")
      }
      if (parsed.kind === "release") {
        const request = await requireRecord(Keys.request(orgID, parsed.value.subjectID, parsed.value.requestID))
        const accepted = request.kind === "request" ? request.value.accepted : undefined
        if (
          !accepted ||
          accepted.effect.kind !== "inbox" ||
          accepted.effect.mode !== "task" ||
          accepted.effect.messageID !== parsed.value.rootID ||
          accepted.permit.provisionalGrantID !== parsed.value.grantID ||
          accepted.permit.admissionID !== parsed.value.admissionID ||
          accepted.permit.attemptID !== parsed.value.attemptID ||
          accepted.permit.runtimeID !== parsed.value.runtimeID ||
          accepted.permit.bindingEpoch !== parsed.value.bindingEpoch ||
          accepted.acceptedAt !== parsed.value.acceptedAt ||
          !same(accepted.permit.actor, parsed.value.actor)
        )
          fail("Portable release has no exact accepted native root")
      }
      if (parsed.kind === "request" || parsed.kind === "release") {
        const [existing] = await Storage.readMany([entry.key])
        if (existing !== undefined && !same(existing, entry.value))
          fail("Portable immutable command identity collides with destination history")
      }
    }
    if (
      headers !== 1 ||
      records !== header.records ||
      slots !== header.commandSeq ||
      checkpoints > 1 ||
      (header.commandSeq > 0 && checkpoints !== 1)
    )
      fail("Portable organization command watermark closure is incomplete")
    for await (const _ of context.staged.artifacts()) fail("Portable command proof cannot contain binary artifacts")
    prepared.set(context, { runtime: RuntimeContext.current(), header })
  }

  async function publish(context: Owners.TargetContext) {
    const proof = prepared.get(context)
    if (!proof || proof.runtime !== RuntimeContext.current())
      fail("Portable commands require their exact prepared context")
    await validate(context)
    const target = await Adoption.binding({
      source: context.session,
      sessionID: context.session.id,
      rootSessionID: context.rootSessionID,
      handoffID: context.handoffID,
      parent: context.session.parentID ? await Session.get(context.session.parentID) : undefined,
    })
    const native = current(await Session.get(context.session.id))
    if (!same(native, target)) fail("Destination lacks the required organization binding adoption capability")
    for await (const old of Storage.records({ prefix: prefix(proof.header), limit: 128 }))
      if (!(await context.staged.record(old.key))) await Storage.remove(old.key)
    for await (const entry of context.staged.records()) {
      if (same(entry.key, headerKey(context))) continue
      const parsed = classify(entry, proof.header)
      if (parsed.kind === "state") continue
      await Storage.write(entry.key, entry.value)
    }
    await Storage.write(
      Keys.state(target.orgID, context.session.id),
      Records.State.parse({
        schemaVersion: 1,
        orgID: target.orgID,
        projectID: target.projectID,
        sessionID: context.session.id,
        runtimeID: target.driverRuntimeID,
        bindingEpoch: target.bindingEpoch,
        commandSeq: proof.header.commandSeq,
      }),
    )
  }

  export function register() {
    Owners.register(id, {
      version,
      reads: [3, 4, version],
      stagedDependencies: ["session-core"],
      publicationAfter: ["session-core"],
      applies: (session) => !!session.organization,
      async inspect() {
        return { requirements: [], children: (async function* () {})() }
      },
      async freeze(context) {
        const binding = await Epochs.ownerPreparationBinding({
          sessionID: context.session.id,
          handoffID: context.handoffID,
        })
        await drainMemberFiles(binding, context.signal)
        if (context.session.id === context.rootSessionID) await drainMemberSync(context.session.id, binding)
        await Storage.snapshot(async () => {
          const binding = current(context.session)
          const [state] = await Storage.readMany([Keys.state(binding.orgID, context.session.id)])
          const header = sourceHeader(context, state)
          const read = async (key: string[]) => {
            const [value] = await Storage.readMany([key])
            return value === undefined ? undefined : { key, value }
          }
          for await (const row of Storage.records({ prefix: prefix(header), limit: 128 })) {
            context.signal.throwIfAborted()
            const parsed = classify(row, header)
            if (parsed.kind === "attempt")
              await closedPosition(header, parsed.value.permit, parsed.value.status !== "rejected", read)
            if (parsed.kind === "skip") await closedPosition(header, parsed.value.permit.command, true, read)
          }
        })
      },
      export: entries,
      validate,
      publish,
    })
  }
}

export const registerOrganizationTransferOwner = OrganizationSessionTransfer.register
