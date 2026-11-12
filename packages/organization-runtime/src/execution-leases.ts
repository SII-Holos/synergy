import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
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
  export const Authority = z.strictObject({
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
  export type Authority = z.infer<typeof Authority>
  const Hint = z.strictObject({ grantID: Identity.ID, generation: z.number().int().nonnegative().safe() })
  export const Settlement = z.discriminatedUnion("kind", [
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
  export const Entry = z
    .strictObject({
      version: z.literal(1),
      entryID: Identity.ID,
      authority: Authority,
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
  const Schema = z.strictObject({ version: z.literal(1), ready: z.literal(true) })
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
    const entry = Entry.parse(raw)
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
      version: 1,
      orgID: proof.orgID,
      deploymentIncarnation: proof.deploymentIncarnation,
      runtimeID: proof.runtimeID,
      sessionID: input.permit.sessionID,
      projectID: input.permit.projectID,
      bindingEpoch: permit.bindingEpoch,
      rootID: input.effect.messageID,
      originGrantID: input.permit.provisionalGrantID,
      input: accepted(input),
      control: control ? { ...accepted(control), handoffID: proof.continuation!.handoffID } : undefined,
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
    const entry = Entry.parse({ version: 1, entryID, authority, uncertainUntil, state: "pending" })
    await save(entry)
    return entry
  }
  export async function original(input: Command.InputAccepted) {
    if (!state().orgID) return
    writing()
    if (!input.permit.provisionalGrantID || input.effect.mode !== "task") return
    const permit = input.permit
    const authority = Authority.parse({
      version: 1,
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
    await enqueue(authority, hash(["original", authority]))
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
    const entry = Entry.parse(value)
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
          raw === undefined ? Entry.parse({ version: 1, entryID, authority, hint, state: "pending" }) : Entry.parse(raw)
        if (
          JSON.stringify(target.authority) !== JSON.stringify(authority) ||
          JSON.stringify(target.hint) !== JSON.stringify(hint)
        )
          fail("Native cleanup generation identity conflicts")
        await save(target)
        if (current.state === "pending" && (!current.hint || current.hint.generation === 0))
          await save(Entry.parse({ ...current, state: "settled", settlement: { kind: "linked", entryID } }))
        return target
      },
      {
        commitGuard() {
          owner()
        },
      },
    )
  }
  export async function settle(value: Entry, outcome: z.infer<typeof Settlement>) {
    const entry = Entry.parse(value)
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
        if (
          current.uncertainUntil !== undefined &&
          ((settlement.kind !== "closed" && settlement.kind !== "absent") ||
            settlement.inspectedAt < current.uncertainUntil)
        )
          fail("Native cleanup dispatch may still commit according to its service inspection")
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
        if (settlement.kind === "linked") {
          const target = await read(settlement.entryID)
          if (
            target.entryID === current.entryID ||
            !target.hint ||
            JSON.stringify(target.authority) !== JSON.stringify(current.authority)
          )
            fail("Native cleanup linkage has another root authority")
        }
        const updated = Entry.parse({ ...current, state: "settled", settlement })
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
    ])
  }
}
