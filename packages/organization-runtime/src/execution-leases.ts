import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { UpgradeWork } from "@ericsanchezok/synergy-harness/storage/upgrade-work"
import { OrganizationCommandRecords as Records } from "./command-records"
import { OrganizationIntakePath as Keys } from "./storage/path"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationExecutionLeases {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const Lookup = Records.Lookup.extend({
    admissionID: Identity.ID,
    attemptID: Identity.ID,
    acceptedHash: z.string().length(64),
  })
  const LegacyAuthority = z.strictObject({
    version: z.literal(1),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    runtimeID: Identity.ID,
    sessionID: Identity.ID,
    projectID: Identity.ID,
    bindingEpoch: z.number().int().positive().safe(),
    rootID: Identity.ID,
    originGrantID: Identity.ID,
    input: Lookup,
    control: Lookup.extend({ handoffID: Identity.ID }).optional(),
  })
  const CurrentAuthority = LegacyAuthority.extend({
    version: z.literal(2),
    control: Lookup.extend(Execution.ContinuationOrigin.shape)
      .refine((value) => Execution.ContinuationOrigin.strip().safeParse(value).success)
      .optional(),
  })
  export const Authority = z.union([LegacyAuthority, CurrentAuthority])
  export type Authority = z.infer<typeof Authority>
  const Hint = z.strictObject({ grantID: Identity.ID, generation: z.number().int().nonnegative().safe() })
  const LegacySettlement = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("terminal"), receipt: Execution.ReleaseReceipt }),
    z.strictObject({
      kind: z.literal("closed"),
      grantID: Identity.ID,
      generation: z.number().int().nonnegative().safe(),
      reason: z.enum(["handoff_closed", "control_closed", "closed"]),
      inspectedAt: z.number().int().nonnegative().safe(),
    }),
    z.strictObject({
      kind: z.literal("absent"),
      controlAdmissionID: Identity.ID,
      inspectedAt: z.number().int().nonnegative().safe(),
    }),
    z.strictObject({ kind: z.literal("linked"), entryID: Identity.ID }),
  ])
  export const Settlement = z.discriminatedUnion("kind", [
    ...LegacySettlement.options,
    z.strictObject({ kind: z.literal("recovered"), entryID: Identity.ID }),
  ])
  const LegacyEntry = z
    .strictObject({
      version: z.literal(1),
      entryID: Identity.ID,
      authority: LegacyAuthority,
      hint: Hint.optional(),
      uncertainUntil: z.number().int().nonnegative().safe().optional(),
      state: z.enum(["pending", "settled"]),
      settlement: LegacySettlement.optional(),
    })
    .refine(
      (value) => (value.state === "pending") === (value.settlement === undefined),
      "Native cleanup settlement must match its state",
    )
    .refine(
      (value) => !value.hint || value.uncertainUntil === undefined,
      "A known generation cannot replace an unresolved dispatch horizon",
    )
  const CurrentEntry = z
    .strictObject({
      version: z.literal(2),
      entryID: Identity.ID,
      authority: CurrentAuthority,
      hint: Hint.optional(),
      uncertainUntil: z.number().int().nonnegative().safe().optional(),
      state: z.enum(["pending", "settled"]),
      settlement: Settlement.optional(),
    })
    .refine(
      (value) => (value.state === "pending") === (value.settlement === undefined),
      "Native cleanup settlement must match its state",
    )
    .refine(
      (value) => !value.hint || value.uncertainUntil === undefined,
      "A known generation cannot replace an unresolved dispatch horizon",
    )
  export const Entry = z.union([LegacyEntry, CurrentEntry])
  function currentEntry(value: unknown) {
    const stored = Entry.parse(value)
    return CurrentEntry.parse({ ...stored, version: 2, authority: { ...stored.authority, version: 2 } })
  }
  export type Entry = z.infer<typeof Entry>
  const Pending = z.strictObject({ version: z.literal(1), entryID: Identity.ID })
  const root = ["organization-execution-leases"]
  const key = (entryID: string) => [...root, "entries", entryID]
  const pending = (runtimeID: string) => [...root, "pending", runtimeID]
  const queued = (entry: Entry) => [...pending(entry.authority.runtimeID), entry.entryID]
  const rootPending = (authority: Pick<Authority, "runtimeID" | "sessionID" | "rootID">) => [
    ...root,
    "pending-root",
    authority.runtimeID,
    authority.sessionID,
    authority.rootID,
  ]
  const queuedRoot = (entry: Entry) => [...rootPending(entry.authority), entry.entryID]
  const schema = [...root, "schema"]
  const Schema = z.strictObject({ version: z.literal(2), ready: z.literal(true) })
  const LegacySchema = z.strictObject({ version: z.literal(1), ready: z.literal(true) })
  const state = RuntimeContext.state(() => ({
    orgID: undefined as string | undefined,
    owner: undefined as
      | {
          store: ReturnType<typeof Storage.current>["store"]
          artifactDirectory: string
          artifactObjects: ReturnType<typeof Storage.current>["artifactObjects"]
        }
      | undefined,
    listeners: new Set<(authority: Authority) => void>(),
  }))
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "PROTOCOL_MISMATCH", message, outcome: "rejected", retryable: false })
  }
  function owner() {
    const current = state()
    const storage = Storage.current()
    current.owner ??= {
      store: storage.store,
      artifactDirectory: storage.artifactDirectory,
      artifactObjects: storage.artifactObjects,
    }
    if (
      current.owner.store !== storage.store ||
      current.owner.artifactDirectory !== storage.artifactDirectory ||
      current.owner.artifactObjects !== storage.artifactObjects
    )
      fail("Native execution cleanup belongs to another storage owner")
    return current
  }
  function writing() {
    owner()
    if (!Storage.inWriteTransaction()) fail("Native cleanup index must join its owning transaction")
  }
  async function read(entryID: string) {
    owner()
    const [raw] = await Storage.readMany([key(Identity.ID.parse(entryID))])
    owner()
    if (raw === undefined) fail("Native cleanup entry is unavailable")
    const entry = currentEntry(raw)
    if (entry.entryID !== entryID || entry.authority.orgID !== owner().orgID)
      fail("Native cleanup entry has another identity")
    return entry
  }
  async function save(entry: Entry) {
    writing()
    await Storage.write(key(entry.entryID), entry)
    if (entry.state === "pending") {
      const value = Pending.parse({ version: 1, entryID: entry.entryID })
      await Storage.write(queued(entry), value)
      await Storage.write(queuedRoot(entry), value)
    } else {
      await Storage.remove(queued(entry))
      await Storage.remove(queuedRoot(entry))
    }
    Storage.afterCommit(() => {
      for (const listener of owner().listeners) listener(entry.authority)
    })
  }
  function accepted(value: Command.InputAccepted | Command.ControlAccepted) {
    return {
      subjectID: value.permit.actor.subjectID,
      requestID: value.permit.requestID,
      admissionID: value.permit.admissionID,
      attemptID: value.permit.attemptID,
      acceptedHash: hash(value),
    }
  }
  export function acceptedHash(value: Command.InputAccepted | Command.ControlAccepted) {
    return hash(value)
  }
  export function reference(proof: Execution.DescriptionProof | Execution.BindingProof): Authority {
    const input = proof.receipt.accepted!
    const control = proof.continuation?.receipt.accepted
    const permit = control?.permit ?? input.permit
    return Authority.parse({
      version: 2,
      orgID: proof.orgID,
      deploymentIncarnation: proof.deploymentIncarnation,
      runtimeID: proof.runtimeID,
      sessionID: input.permit.sessionID,
      projectID: input.permit.projectID,
      bindingEpoch: permit.bindingEpoch,
      rootID: input.effect.messageID,
      originGrantID: input.permit.provisionalGrantID,
      input: accepted(input),
      ...(control && { control: { ...accepted(control), ...Execution.continuationOrigin(proof.continuation!) } }),
    })
  }
  async function enqueue(authority: Authority, deterministic?: string, uncertainUntil?: number) {
    writing()
    if (authority.orgID !== owner().orgID) fail("Native cleanup authority belongs to another organization")
    const entryID = deterministic ?? crypto.randomUUID()
    if (deterministic) {
      const [raw] = await Storage.readMany([key(entryID)])
      if (raw !== undefined) {
        const current = await read(entryID)
        if (JSON.stringify(current.authority) !== JSON.stringify(authority))
          fail("Native cleanup reception has another authority")
        return current
      }
    }
    const entry = currentEntry({ version: 2, entryID, authority, uncertainUntil, state: "pending" })
    await save(entry)
    return entry
  }
  export async function original(input: Command.InputAccepted) {
    if (!state().orgID) return
    writing()
    if (!input.permit.provisionalGrantID || input.effect.mode !== "task") return
    const permit = input.permit
    const authority = Authority.parse({
      version: 2,
      orgID: permit.orgID,
      deploymentIncarnation: permit.deploymentIncarnation,
      runtimeID: permit.runtimeID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      bindingEpoch: permit.bindingEpoch,
      rootID: input.effect.messageID,
      originGrantID: permit.provisionalGrantID,
      input: accepted(input),
    })
    await enqueue(authority, hash(["original", { ...authority, version: 1 }]))
  }
  export async function begin(value: Execution.DescriptionProof | Execution.BindingProof) {
    const proof =
      value.purpose === "execution-resource-description"
        ? Execution.DescriptionProof.parse(value)
        : Execution.BindingProof.parse(value)
    const authority = reference(proof)
    owner()
    const [registered] = await Storage.readMany([schema])
    if (!Schema.safeParse(registered).success) fail("Native cleanup requires its owning migration")
    return Storage.transaction(() => enqueue(authority, undefined, proof.expiresAt), {
      commitGuard() {
        owner()
      },
    })
  }
  export function confirm(value: Entry, observed: Execution.Grant) {
    return observeGrant(value, observed)
  }
  export function observe(value: Entry, observed: Execution.Grant, inspectedAt: number) {
    return observeGrant(value, observed, z.number().int().nonnegative().safe().parse(inspectedAt))
  }
  async function observeGrant(value: Entry, observed: Execution.Grant, inspectedAt?: number) {
    const entry = currentEntry(value)
    const grant = Execution.Grant.parse(observed)
    const authority = entry.authority
    if (
      grant.orgID !== authority.orgID ||
      grant.deploymentIncarnation !== authority.deploymentIncarnation ||
      grant.runtimeID !== authority.runtimeID ||
      grant.sessionID !== authority.sessionID ||
      grant.projectID !== authority.projectID ||
      grant.bindingEpoch !== authority.bindingEpoch ||
      grant.admissionID !== authority.input.admissionID ||
      grant.attemptID !== authority.input.attemptID ||
      (grant.provenance?.originGrantID ?? grant.grantID) !== authority.originGrantID ||
      grant.provenance?.control.permit.admissionID !== authority.control?.admissionID ||
      (grant.state === "bound" && grant.rootID !== authority.rootID)
    )
      fail("Native cleanup observation has another canonical grant")
    const generation = grant.state === "bound" ? grant.retention.generation : 0
    const hint = Hint.parse({ grantID: grant.grantID, generation })
    return Storage.transaction(
      async () => {
        const current = await read(entry.entryID)
        if (inspectedAt !== undefined && current.uncertainUntil !== undefined && inspectedAt < current.uncertainUntil)
          fail("Native cleanup dispatch may still commit according to its service inspection")
        if (JSON.stringify(current.authority) !== JSON.stringify(authority)) fail("Native cleanup authority changed")
        if (current.hint && JSON.stringify(current.hint) === JSON.stringify(hint)) return current
        const entryID = hash([authority, hint])
        const [raw] = await Storage.readMany([key(entryID)])
        const target =
          raw === undefined
            ? currentEntry({ version: 2, entryID, authority, hint, state: "pending" })
            : currentEntry(raw)
        if (
          JSON.stringify(target.authority) !== JSON.stringify(authority) ||
          JSON.stringify(target.hint) !== JSON.stringify(hint)
        )
          fail("Native cleanup generation identity conflicts")
        await save(target)
        if (current.state === "pending" && (!current.hint || current.hint.generation === 0))
          await save(currentEntry({ ...current, state: "settled", settlement: { kind: "linked", entryID } }))
        return target
      },
      {
        commitGuard() {
          owner()
        },
      },
    )
  }
  function validateHorizon(current: Entry, settlement: z.infer<typeof Settlement>) {
    if (
      current.uncertainUntil !== undefined &&
      ((settlement.kind !== "closed" && settlement.kind !== "absent") ||
        settlement.inspectedAt < current.uncertainUntil)
    )
      fail("Native cleanup dispatch may still commit according to its service inspection")
  }
  async function validateSettlement(current: Entry, settlement: z.infer<typeof Settlement>) {
    if (
      settlement.kind === "terminal" &&
      (!current.hint ||
        settlement.receipt.orgID !== current.authority.orgID ||
        settlement.receipt.deploymentIncarnation !== current.authority.deploymentIncarnation ||
        settlement.receipt.grantID !== current.hint.grantID ||
        settlement.receipt.generation !== current.hint.generation ||
        settlement.receipt.rootID !== current.authority.rootID ||
        settlement.receipt.sessionID !== current.authority.sessionID ||
        settlement.receipt.runtimeID !== current.authority.runtimeID ||
        settlement.receipt.bindingEpoch !== current.authority.bindingEpoch)
    )
      fail("Native terminal receipt has another generation")
    if (
      settlement.kind === "closed" &&
      (!current.hint ||
        settlement.grantID !== current.hint.grantID ||
        settlement.generation !== current.hint.generation)
    )
      fail("Native nonterminal closure has another generation")
    if (
      settlement.kind === "absent" &&
      (current.hint || settlement.controlAdmissionID !== current.authority.control?.admissionID)
    )
      fail("Native absence does not match an unobserved control intent")
    if (settlement.kind === "recovered") {
      const target = await read(settlement.entryID)
      if (target.entryID === current.entryID || !restoredLink(current, target))
        fail("Native restored cleanup linkage has another original input or current recovery origin")
    }
    if (settlement.kind === "linked") {
      const target = await read(settlement.entryID)
      if (
        target.entryID === current.entryID ||
        !target.hint ||
        JSON.stringify(target.authority) !== JSON.stringify(current.authority)
      )
        fail("Native cleanup linkage has another root authority")
    }
  }

  function restoredLink(current: Entry, target: Entry) {
    const before = current.authority,
      after = target.authority
    return (
      (!current.hint || (current.hint.grantID === before.originGrantID && current.hint.generation === 0)) &&
      current.uncertainUntil === undefined &&
      !before.control &&
      !!target.hint &&
      !!after.control &&
      "recovery" in after.control &&
      !!after.control.recovery &&
      before.deploymentIncarnation !== after.deploymentIncarnation &&
      (["orgID", "runtimeID", "sessionID", "projectID", "bindingEpoch", "rootID", "originGrantID"] as const).every(
        (field) => before[field] === after[field],
      ) &&
      JSON.stringify(before.input) === JSON.stringify(after.input)
    )
  }
  export async function recoverQueuedOriginal(
    value: Entry,
    observed: Execution.Grant,
    commit: (accepted: Command.InputAccepted) => Promise<void>,
  ) {
    writing()
    const target = await read(value.entryID),
      grant = Execution.Grant.parse(observed)
    const provenance = grant.provenance
    if (!provenance?.recovery || provenance.predecessorGrantID !== provenance.originGrantID) return
    const control = target.authority.control
    if (
      !control ||
      !target.hint ||
      grant.state === "closed" ||
      target.hint.grantID !== grant.grantID ||
      target.hint.generation !== (grant.state === "bound" ? grant.retention.generation : 0) ||
      control.admissionID !== provenance.control.permit.admissionID ||
      !("recovery" in control) ||
      JSON.stringify(control.recovery) !== JSON.stringify(provenance.recovery) ||
      grant.orgID !== target.authority.orgID ||
      grant.deploymentIncarnation !== target.authority.deploymentIncarnation ||
      grant.runtimeID !== target.authority.runtimeID ||
      grant.sessionID !== target.authority.sessionID ||
      grant.projectID !== target.authority.projectID ||
      grant.bindingEpoch !== target.authority.bindingEpoch ||
      provenance.rootID !== target.authority.rootID ||
      provenance.originGrantID !== target.authority.originGrantID
    )
      fail("Restored queued cleanup has another current accepted generation")
    const request = Records.Request.parse(
      await Storage.read(
        Keys.request(target.authority.orgID, target.authority.input.subjectID, target.authority.input.requestID),
      ),
    )
    const input = Command.InputAccepted.parse(request.accepted),
      permit = input.permit
    if (
      input.effect.mode !== "task" ||
      acceptedHash(input) !== target.authority.input.acceptedHash ||
      permit.provisionalGrantID !== provenance.originGrantID ||
      permit.admissionID !== target.authority.input.admissionID ||
      permit.attemptID !== target.authority.input.attemptID ||
      input.effect.messageID !== target.authority.rootID
    )
      fail("Restored queued cleanup lacks its original native intake")
    const authority = Authority.parse({
      version: 2,
      orgID: permit.orgID,
      deploymentIncarnation: permit.deploymentIncarnation,
      runtimeID: permit.runtimeID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      bindingEpoch: permit.bindingEpoch,
      rootID: input.effect.messageID,
      originGrantID: permit.provisionalGrantID,
      input: accepted(input),
    })
    const entries = await captureEntries()
    const roots = entries.filter((entry) => JSON.stringify(entry.authority) === JSON.stringify(authority))
    if (roots.length && roots.every((entry) => entry.state === "settled")) return
    if (permit.runtimeID !== grant.runtimeID || permit.bindingEpoch !== grant.bindingEpoch) {
      const [raw] = await Storage.readMany([Keys.release(permit.orgID, permit.actor.subjectID, permit.requestID)])
      const parsed = Records.Release.safeParse(raw)
      const release = parsed.success ? parsed.data : undefined
      const receipt = release?.receipt
      const binding = await Epochs.inspectOwnerBinding({ sessionID: permit.sessionID, rootSessionID: permit.sessionID })
      const actual = binding ? await Epochs.inspect(binding) : undefined
      if (
        roots.length ||
        !binding ||
        actual?.role !== "target" ||
        actual.phase !== "activated" ||
        binding.targetID !== grant.runtimeID ||
        binding.toEpoch !== grant.bindingEpoch ||
        binding.sessionID !== permit.sessionID ||
        permit.bindingEpoch >= binding.toEpoch ||
        !release ||
        release.state !== "released" ||
        !receipt ||
        release.orgID !== permit.orgID ||
        release.subjectID !== permit.actor.subjectID ||
        release.requestID !== permit.requestID ||
        release.sessionID !== permit.sessionID ||
        release.projectID !== permit.projectID ||
        release.runtimeID !== permit.runtimeID ||
        release.bindingEpoch !== permit.bindingEpoch ||
        release.rootID !== input.effect.messageID ||
        release.grantID !== permit.provisionalGrantID ||
        release.admissionID !== permit.admissionID ||
        release.attemptID !== permit.attemptID ||
        release.acceptedAt !== input.acceptedAt ||
        JSON.stringify(release.actor) !== JSON.stringify(permit.actor) ||
        receipt.orgID !== permit.orgID ||
        receipt.deploymentIncarnation !== permit.deploymentIncarnation ||
        receipt.runtimeID !== permit.runtimeID ||
        receipt.sessionID !== permit.sessionID ||
        receipt.bindingEpoch !== permit.bindingEpoch ||
        receipt.rootID !== input.effect.messageID ||
        receipt.grantID !== permit.provisionalGrantID
      )
        fail("Transferred cleanup requires its original released intake and actual activated destination")
      return
    }
    const pending = roots.filter((entry) => entry.state === "pending")
    if (pending.length !== 1 || !queuedOriginal(roots, pending[0]!, input) || !restoredLink(pending[0]!, target))
      fail("Restoration cannot replace an original dispatch or generation")
    await commit(input)
    await save(
      currentEntry({ ...pending[0]!, state: "settled", settlement: { kind: "recovered", entryID: target.entryID } }),
    )
  }

  export function queuedOriginal(entries: readonly Entry[], pending: Entry, input: Command.InputAccepted) {
    owner()
    const permit = input.permit
    if (input.effect.mode !== "task" || !permit.provisionalGrantID) return false
    const authority = Authority.parse({
      version: 2,
      orgID: permit.orgID,
      deploymentIncarnation: permit.deploymentIncarnation,
      runtimeID: permit.runtimeID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      bindingEpoch: permit.bindingEpoch,
      rootID: input.effect.messageID,
      originGrantID: permit.provisionalGrantID,
      input: accepted(input),
    })
    const originalID = hash(["original", { ...authority, version: 1 }])
    const hint = { grantID: permit.provisionalGrantID, generation: 0 }
    const generationIDs = new Set([hash([authority, hint]), hash([{ ...authority, version: 1 }, hint])])
    const rows = new Map<string, Entry>()
    for (const entry of entries) {
      if (
        rows.has(entry.entryID) ||
        entry.uncertainUntil !== undefined ||
        entry.authority.control ||
        JSON.stringify(entry.authority) !== JSON.stringify(authority) ||
        (entry.hint
          ? JSON.stringify(entry.hint) !== JSON.stringify(hint) || !generationIDs.has(entry.entryID)
          : entry.entryID !== originalID)
      )
        return false
      rows.set(entry.entryID, entry)
    }
    const original = rows.get(originalID)
    if (
      !original ||
      original.hint ||
      pending.state !== "pending" ||
      JSON.stringify(rows.get(pending.entryID)) !== JSON.stringify(pending) ||
      [...rows.values()].filter((entry) => entry.state === "pending").length !== 1
    )
      return false
    if (!pending.hint) return rows.size === 1 && pending.entryID === originalID
    if (original.state !== "settled" || original.settlement?.kind !== "linked") return false
    for (const entry of rows.values()) {
      const visited = new Set<string>()
      let current = entry
      while (current.entryID !== pending.entryID) {
        if (visited.has(current.entryID) || current.state !== "settled" || current.settlement?.kind !== "linked")
          return false
        visited.add(current.entryID)
        const next = rows.get(current.settlement.entryID)
        if (!next) return false
        current = next
      }
    }
    return true
  }

  export async function captureEntries() {
    const selected = owner()
    if (!selected.orgID) fail("Native capture requires its registered cleanup owner")
    return Storage.snapshot(async () => {
      const [coverage] = await Storage.readMany([schema])
      if (!Schema.safeParse(coverage).success && !LegacySchema.safeParse(coverage).success)
        fail("Native capture requires its completed owning cleanup migration")
      const entries: Entry[] = []
      for await (const row of Storage.records({ prefix: [...root, "entries"], limit: 128 })) {
        const entry = currentEntry(row.value)
        if (JSON.stringify(row.key) !== JSON.stringify(key(entry.entryID)) || entry.authority.orgID !== selected.orgID)
          fail("Native cleanup capture found a foreign or unknown canonical entry")
        if (entry.state === "settled" && entry.settlement) {
          if (entry.settlement.kind !== "linked") validateHorizon(entry, entry.settlement)
          await validateSettlement(entry, entry.settlement)
        }
        owner()
        entries.push(entry)
      }
      const byID = new Map(entries.map((entry) => [entry.entryID, entry]))
      const expected = entries.filter((entry) => entry.state === "pending").length
      for (const [prefix, address] of [
        [...root, "pending"],
        [...root, "pending-root"],
      ].map((prefix, index) => [prefix, index === 0 ? queued : queuedRoot] as const)) {
        const seen = new Set<string>()
        for await (const row of Storage.records({ prefix, limit: 128 })) {
          const indexed = Pending.parse(row.value),
            entry = byID.get(indexed.entryID)
          if (
            !entry ||
            entry.state !== "pending" ||
            seen.has(indexed.entryID) ||
            JSON.stringify(row.key) !== JSON.stringify(address(entry))
          )
            fail("Native cleanup capture has another original pending index")
          seen.add(indexed.entryID)
        }
        if (seen.size !== expected) fail("Native cleanup capture lacks its complete original pending indexes")
      }
      owner()
      return entries
    })
  }
  export async function pendingForCapture() {
    const selected = owner()
    if (!selected.orgID) fail("Native capture requires its registered cleanup owner")
    return Storage.snapshot(async () => {
      const [coverage] = await Storage.readMany([schema])
      if (!Schema.safeParse(coverage).success && !LegacySchema.safeParse(coverage).success)
        fail("Native capture requires its completed owning cleanup migration")
      let pending = false
      for await (const row of Storage.records({ prefix: [...root, "entries"], limit: 128 })) {
        const entry = currentEntry(row.value)
        if (JSON.stringify(row.key) !== JSON.stringify(key(entry.entryID)) || entry.authority.orgID !== selected.orgID)
          fail("Native cleanup capture found a foreign or unknown canonical entry")
        if (entry.state === "pending") pending = true
        else if (entry.settlement) {
          if (entry.settlement.kind !== "linked") validateHorizon(entry, entry.settlement)
          await validateSettlement(entry, entry.settlement)
        }
        owner()
      }
      return pending
    })
  }

  export async function settle(value: Entry, outcome: z.infer<typeof Settlement>) {
    const entry = currentEntry(value)
    const settlement = Settlement.parse(outcome)
    return Storage.transaction(
      async () => {
        const current = await read(entry.entryID)
        if (JSON.stringify(current) !== JSON.stringify(entry)) {
          if (current.state === "settled" && JSON.stringify(current.settlement) === JSON.stringify(settlement))
            return current
          fail("Native cleanup entry changed before settlement")
        }
        if (current.state !== "pending") return current
        validateHorizon(current, settlement)
        await validateSettlement(current, settlement)
        const updated = currentEntry({ ...current, state: "settled", settlement })
        await save(updated)
        return updated
      },
      {
        commitGuard() {
          owner()
        },
      },
    )
  }
  export async function page(
    runtimeID: string,
    input: { after?: string; limit?: number; target?: { sessionID: string; rootID: string } } = {},
  ) {
    const selected = Identity.ID.parse(runtimeID)
    const target = input.target
      ? { sessionID: Identity.ID.parse(input.target.sessionID), rootID: Identity.ID.parse(input.target.rootID) }
      : undefined
    const after = input.after === undefined ? undefined : Identity.ID.parse(input.after)
    const limit = z
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(input.limit ?? 16)
    owner()
    return Storage.snapshot(async () => {
      const [registered] = await Storage.readMany([schema])
      if (!Schema.safeParse(registered).success) fail("Native cleanup requires its owning migration")
      const prefix = target ? rootPending({ runtimeID: selected, ...target }) : pending(selected)
      const rows = await Storage.query({ prefix, after: after ? [...prefix, after] : undefined, limit })
      owner()
      const items: Entry[] = []
      for (const row of rows) {
        const indexed = Pending.parse(row.value)
        if (row.key.at(-1) !== indexed.entryID) fail("Native cleanup pending index has another identity")
        const entry = await read(indexed.entryID)
        if (
          entry.state !== "pending" ||
          entry.authority.runtimeID !== selected ||
          (target && (entry.authority.sessionID !== target.sessionID || entry.authority.rootID !== target.rootID))
        )
          fail("Native cleanup pending index is inconsistent")
        items.push(entry)
      }
      return { items, cursor: rows.length === limit ? rows.at(-1)!.key.at(-1) : undefined }
    })
  }
  export function subscribe(listener: (authority: Authority) => void) {
    const listeners = owner().listeners
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  export function register(orgID: string) {
    const current = state()
    const selected = Identity.ID.parse(orgID)
    if (current.orgID === selected) return
    if (current.orgID) fail("Native cleanup organization cannot change")
    current.orgID = selected
    MigrationRegistry.register("organization-execution-leases", [
      {
        id: "20261112-organization-native-cleanup-intents",
        scope: "global",
        execution: "startup",
        description: "Index original resource reception without reopening immutable release history",
        async up(progress) {
          owner()
          let count = 0
          for await (const row of Storage.records({ prefix: Keys.releases(selected), limit: 128 })) {
            UpgradeWork.signal()?.throwIfAborted()
            const release = Records.Release.parse(row.value)
            const [raw] = await Storage.readMany([Keys.request(selected, release.subjectID, release.requestID)])
            const request = Records.Request.parse(raw)
            const input = Command.InputAccepted.parse(request.accepted)
            if (
              input.effect.messageID !== release.rootID ||
              input.permit.provisionalGrantID !== release.grantID ||
              input.permit.sessionID !== release.sessionID ||
              input.permit.runtimeID !== release.runtimeID ||
              input.permit.bindingEpoch !== release.bindingEpoch
            )
              fail("Original cleanup index has another native reception")
            await Storage.transaction(() => original(input))
            progress(++count, 0)
          }
          await Storage.write(schema, { version: 1, ready: true })
          progress(count, count)
        },
      },
      {
        id: "20261116-organization-native-restoration-cleanup-authority",
        scope: "global",
        execution: "startup",
        dependsOn: ["20261112-organization-native-cleanup-intents"],
        description: "Version restoration control origins without changing original cleanup entry identities",
        async up(progress) {
          owner()
          let count = 0
          for await (const row of Storage.records({ prefix: [...root, "entries"], limit: 128 })) {
            UpgradeWork.signal()?.throwIfAborted()
            const entry = currentEntry(row.value)
            if (JSON.stringify(row.key) !== JSON.stringify(key(entry.entryID)) || entry.authority.orgID !== selected)
              fail("Native cleanup upgrade found another original owner")
            await Storage.transaction(() => save(entry))
            progress(++count, 0)
          }
          await Storage.write(schema, { version: 2, ready: true })
          progress(count, count)
        },
      },
    ])
  }
}
