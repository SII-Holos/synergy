import { createHash } from "node:crypto"
import { z } from "zod"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

const families = [
  "shared-events",
  "shared-sessions",
  "shared-batches",
  "transcript",
  "task-projection",
  "shared-blobs",
] as const
const Family = z.enum(families)
const Count = z.number().int().nonnegative().safe()
const Metadata = z.strictObject({
  orgID: Identity.ID,
  sessionID: Identity.ID,
  projectID: Identity.ID,
  creatorID: Identity.ID,
  createdAt: Count,
})
function metadata(session: Record.SessionDirectory) {
  const { orgID, sessionID, projectID, creatorID, createdAt } = session
  return Metadata.parse({ orgID, sessionID, projectID, creatorID, createdAt })
}
const Binding = z.strictObject({
  runtimeID: Identity.ID,
  bindingEpoch: Protocol.Epoch,
})
const Item = z.strictObject({
  family: Family,
  key: z.array(z.string()).min(4),
  hash: Protocol.Digest,
})
const Page = z.strictObject({
  version: z.literal(1),
  ordinal: Count,
  items: z.array(Item).min(1).max(128),
})
const FamilyCount = z.strictObject({ family: Family, records: Count })
const Origin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("home-maintenance") }),
  z.strictObject({
    kind: z.literal("archive-inventory"),
    installationID: Identity.ID,
    incarnation: Identity.ID,
    namespaceHash: Protocol.Digest,
    nativeHash: Protocol.Digest,
    sourceOwner: z
      .discriminatedUnion("schemaVersion", [HomeOwnershipFile.FencedInfo, HomeOwnershipFile.RestorationInfo])
      .refine((value) => value.owner === "organization", "Retained Service history has another native source owner"),
  }),
])
const Retained = z.strictObject({
  origin: Origin,
  kind: z.literal("retained-inventory"),
  retainedNextSeq: Count.positive(),
  observedAt: Count,
  families: z.array(FamilyCount).length(families.length),
  pages: Count,
  records: Count,
  hash: Protocol.Digest,
})
const Revoked = z.strictObject({
  kind: z.literal("unshare"),
  state: Record.SharedState,
  terminalBatch: Record.SharedBatch.nullable(),
})
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const prefix = (sessionID: string, generation: number) => [
  "organization",
  "shared-generations",
  sessionID,
  String(generation),
]
const pageKey = (sessionID: string, generation: number, ordinal: number) => [
  ...prefix(sessionID, generation),
  "inventory",
  String(ordinal).padStart(16, "0"),
]
const schemaKey = ["organization", "shared-generation-schema"]
const Schema = z.strictObject({ schemaVersion: z.literal(1) })
function invalid(): never {
  fail("PROTOCOL_MISMATCH", "Historical shared generation lacks its original revocation or retained inventory")
}

export namespace OrganizationSharedGeneration {
  export const RetainedOrigin = Origin
  export type RetainedOrigin = z.infer<typeof Origin>
  export type ArchiveOrigin = Extract<RetainedOrigin, { kind: "archive-inventory" }>
  export const Closed = z.strictObject({
    version: z.literal(1),
    identity: Metadata,
    generation: Count.positive(),
    binding: Binding,
    revokedByGeneration: Count.positive(),
    proof: z.discriminatedUnion("kind", [Revoked, Retained]),
  })
  export type Closed = z.infer<typeof Closed>
  export const EmptyRange = z.strictObject({
    version: z.literal(1),
    provenance: z.literal("retained-empty-inventory"),
    origin: Origin,
    identity: Metadata,
    firstGeneration: Count.positive(),
    lastGeneration: Count.positive(),
    observedAt: Count,
  })
  export type EmptyRange = z.infer<typeof EmptyRange>
  export const emptyRoot = ["organization", "shared-generation-empty-ranges"]
  export const emptyKey = (sessionID: string, first: number) => [
    ...emptyRoot,
    sessionID,
    String(first).padStart(16, "0"),
  ]
  export function inspectEmpty(range: EmptyRange, session: Record.SessionDirectory) {
    if (
      !equal(range.identity, metadata(session)) ||
      range.firstGeneration % 2 !== 1 ||
      range.lastGeneration % 2 !== 1 ||
      range.firstGeneration > range.lastGeneration ||
      range.lastGeneration >= session.shareGeneration
    )
      invalid()
  }
  export const key = prefix
  export const root = ["organization", "shared-generations"]
  export const generationFamilies = families
  export function nextSeq(closed: Closed) {
    return closed.proof.kind === "unshare" ? closed.proof.state.nextSeq : closed.proof.retainedNextSeq
  }
  export function inspect(closed: Closed, session: Record.SessionDirectory) {
    if (
      !equal(closed.identity, metadata(session)) ||
      closed.generation % 2 !== 1 ||
      closed.revokedByGeneration !== closed.generation + 1 ||
      closed.revokedByGeneration > session.shareGeneration ||
      closed.binding.bindingEpoch > session.bindingEpoch
    )
      invalid()
    if (closed.proof.kind === "unshare") {
      const { state, terminalBatch } = closed.proof
      if (
        state.sessionID !== session.sessionID ||
        state.shareGeneration !== closed.generation ||
        state.bindingEpoch !== closed.binding.bindingEpoch ||
        state.nextSeq < 1 ||
        (state.nextSeq === 1
          ? terminalBatch !== null
          : !terminalBatch ||
            terminalBatch.sessionID !== session.sessionID ||
            terminalBatch.projectID !== session.projectID ||
            terminalBatch.shareGeneration !== closed.generation ||
            terminalBatch.lastSeq !== state.nextSeq - 1 ||
            terminalBatch.bindingEpoch !== closed.binding.bindingEpoch)
      )
        invalid()
    }
    return {
      ...session,
      shareState: "shared" as const,
      shareGeneration: closed.generation,
      driverRuntimeID: closed.binding.runtimeID,
      bindingEpoch: closed.binding.bindingEpoch,
    }
  }
  export async function revoke(session: Record.SessionDirectory) {
    if (!Storage.inWriteTransaction() || session.shareState !== "shared") invalid()
    const state = await Record.read(Record.SharedState, Keys.sharedState(session.sessionID))
    if (!state) invalid()
    const rows = await Storage.query({
      prefix: Keys.sharedBatch(session.sessionID, session.shareGeneration, 1).slice(0, -1),
      descending: true,
      limit: 1,
    })
    const terminalBatch = rows.length ? Record.SharedBatch.parse(rows[0]!.value) : null
    if (
      terminalBatch &&
      !equal(rows[0]!.key, Keys.sharedBatch(session.sessionID, session.shareGeneration, terminalBatch.firstSeq))
    )
      invalid()
    const closed = Closed.parse({
      version: 1,
      identity: metadata(session),
      generation: session.shareGeneration,
      binding: {
        runtimeID: session.driverRuntimeID,
        bindingEpoch: session.bindingEpoch,
      },
      revokedByGeneration: session.shareGeneration + 1,
      proof: { kind: "unshare", state, terminalBatch },
    })
    inspect(closed, {
      ...session,
      shareGeneration: session.shareGeneration + 1,
    })
    if ((await Storage.readMany([key(session.sessionID, session.shareGeneration)]))[0] !== undefined) invalid()
    await Storage.write(key(session.sessionID, session.shareGeneration), closed)
  }
  export function history(
    source: Record.HistoricalReader & {
      accept(key: string[]): void
      first(group: string[], value: unknown): boolean
    },
    closed: Closed,
  ) {
    if (closed.proof.kind === "unshare") {
      if (closed.proof.terminalBatch) {
        const original = closed.proof.terminalBatch
        if (
          !equal(
            source.read(
              Record.SharedBatch,
              Keys.sharedBatch(original.sessionID, original.shareGeneration, original.firstSeq),
            ),
            original,
          )
        )
          invalid()
      }
      for (const _row of source.entries([...key(closed.identity.sessionID, closed.generation), "inventory"])) invalid()
      return
    }
    const selected = closed.proof
    const counts = new Map(families.map((family) => [family, 0]))
    const digest = createHash("sha256")
    let pages = 0,
      records = 0
    for (const row of source.entries([...key(closed.identity.sessionID, closed.generation), "inventory"])) {
      const page = Page.parse(row.value)
      if (page.ordinal !== pages || !equal(row.key, pageKey(closed.identity.sessionID, closed.generation, pages)))
        invalid()
      digest.update(hash(page) + "\n")
      for (const item of page.items) {
        if (
          !source.first(["retained-shared-row", ...item.key], item.hash) ||
          item.key[0] !== "organization" ||
          item.key[1] !== item.family ||
          item.key[2] !== closed.identity.sessionID ||
          item.key[3] !== String(closed.generation)
        )
          invalid()
        if (hash(source.read(z.unknown(), item.key)) !== item.hash) invalid()
        counts.set(item.family, counts.get(item.family)! + 1)
        records++
      }
      source.accept(row.key)
      pages++
    }
    if (pages !== selected.pages || records !== selected.records || digest.digest("hex") !== selected.hash) invalid()
    for (const [index, family] of families.entries()) {
      const expected = selected.families[index]!
      if (expected.family !== family || expected.records !== counts.get(family)) invalid()
      let actual = 0
      for (const row of source.entries([
        "organization",
        family,
        closed.identity.sessionID,
        String(closed.generation),
      ])) {
        if (source.first(["retained-shared-row", ...row.key], hash(row.value))) invalid()
        actual++
      }
      if (actual !== expected.records) invalid()
    }
  }
  export async function initialized() {
    const [value] = await Storage.readMany([schemaKey])
    if (value === undefined) return false
    Schema.parse(value)
    return true
  }
  export const initialization: Migration = {
    id: "20261116-organization-shared-generation-registration",
    description: "Register the current shared-generation metadata owner",
    scope: "global",
    execution: "startup",
    async up(progress) {
      progress(1, 1)
    },
  }
  export async function initializeEmpty() {
    await Storage.transaction(async (tx) => {
      for await (const _row of tx.records()) return
      await Storage.write(schemaKey, Schema.parse({ schemaVersion: 1 }))
    })
  }
  export async function assertCoverage(assert: () => void) {
    await Storage.snapshot(async (tx) => {
      const counts = new Map<string, { prefix: string[]; records: number }>()
      const owned = new Set<string>(["sessions", ...families, "shared-generations", "shared-generation-empty-ranges"])
      const sessions = new Set<string>()
      const add = (prefix: string[]) => {
        const id = JSON.stringify(prefix),
          previous = counts.get(id)
        if (previous) previous.records++
        else counts.set(id, { prefix, records: 1 })
      }
      for await (const row of tx.records()) {
        assert()
        if (row.key[0] !== "organization") continue
        add(["organization"])
        if (!owned.has(row.key[1]!)) continue
        if (!row.key[2]) invalid()
        sessions.add(row.key[2])
        for (let length = 2; length <= Math.min(4, row.key.length); length++) add(row.key.slice(0, length))
      }
      const ids = [...sessions]
      for (let offset = 0; offset < ids.length; offset += 128) {
        assert()
        const selected = ids.slice(offset, offset + 128)
        const values = await tx.readMany(selected.map((id) => Keys.session(id)))
        for (const [index, id] of selected.entries()) {
          const value = values[index]
          if (value === undefined || Record.SessionDirectory.parse(value).sessionID !== id) invalid()
        }
      }
      for (const { prefix, records } of counts.values()) {
        let count = 0
        let after: string[] | undefined
        for (;;) {
          assert()
          const page = await tx.queryKeys({ prefix, after, limit: 128 })
          for (const key of page) {
            if (!prefix.every((part, index) => key[index] === part)) invalid()
            count++
          }
          if (count > records) invalid()
          if (page.length < 128) break
          after = page.at(-1)!
        }
        if (count !== records) invalid()
      }
      assert()
    })
  }
  interface InventoryCapture {
    origin: RetainedOrigin
    observedAt: number
    rows(prefix: string[]): AsyncIterable<{ key: string[]; value: unknown }>
    read(key: string[]): Promise<unknown | undefined>
    write(key: string[], value: unknown): Promise<void>
    assert(): void
  }
  async function retain(session: Record.SessionDirectory, capture: InventoryCapture) {
    Count.parse(session.shareGeneration)
    if (session.shareGeneration % 2 !== (session.shareState === "shared" ? 1 : 0)) invalid()
    const load = async <T>(schema: z.ZodType<T>, key: string[]) => {
      const value = await capture.read(key)
      return value === undefined ? undefined : schema.parse(value)
    }
    const generations = new Set<number>()
    for (const family of families)
      for await (const entry of capture.rows(["organization", family, session.sessionID])) {
        const generation = Count.positive().parse(Number(entry.key[3]))
        if (String(generation) !== entry.key[3] || generation % 2 !== 1 || generation > session.shareGeneration)
          invalid()
        if (generation < session.shareGeneration) generations.add(generation)
      }
    for await (const entry of capture.rows([...root, session.sessionID])) {
      if (entry.key.length !== 4) continue
      const closed = Closed.parse(entry.value)
      if (!equal(entry.key, key(session.sessionID, closed.generation))) invalid()
      inspect(closed, session)
      generations.add(closed.generation)
    }
    const ordered = [...generations].sort((left, right) => left - right)
    const gaps: Array<{ first: number; last: number }> = []
    let cursor = 1
    for (const generation of ordered) {
      if (cursor < generation) gaps.push({ first: cursor, last: generation - 2 })
      cursor = generation + 2
    }
    const last = 2 * Math.floor(session.shareGeneration / 2) - 1
    if (cursor <= last) gaps.push({ first: cursor, last })
    for (const gap of gaps) {
      capture.assert()
      const address = emptyKey(session.sessionID, gap.first)
      const previous = await capture.read(address)
      const retained = previous === undefined ? undefined : EmptyRange.parse(previous)
      const range = EmptyRange.parse({
        version: 1,
        provenance: "retained-empty-inventory",
        identity: metadata(session),
        firstGeneration: gap.first,
        lastGeneration: gap.last,
        origin: retained?.origin ?? capture.origin,
        observedAt: retained?.observedAt ?? capture.observedAt,
      })
      inspectEmpty(range, session)
      if (retained) {
        if (!equal(retained, range)) invalid()
      } else await capture.write(address, range)
    }
    let ranges = 0
    for await (const entry of capture.rows([...emptyRoot, session.sessionID])) {
      const range = EmptyRange.parse(entry.value)
      inspectEmpty(range, session)
      if (
        !equal(entry.key, emptyKey(session.sessionID, range.firstGeneration)) ||
        !gaps.some((gap) => gap.first === range.firstGeneration && gap.last === range.lastGeneration)
      )
        invalid()
      ranges++
    }
    if (ranges !== gaps.length) invalid()
    for (const generation of ordered) {
      const previous = await capture.read(key(session.sessionID, generation))
      const retained = previous === undefined ? undefined : Closed.parse(previous)
      if (retained) {
        inspect(retained, session)
        if (
          capture.origin.kind === "archive-inventory" ||
          (retained.proof.kind === "retained-inventory" && retained.proof.origin.kind === "archive-inventory")
        )
          continue
        if (retained.proof.kind === "unshare") {
          if (
            retained.proof.terminalBatch &&
            !equal(
              await load(
                Record.SharedBatch,
                Keys.sharedBatch(session.sessionID, generation, retained.proof.terminalBatch.firstSeq),
              ),
              retained.proof.terminalBatch,
            )
          )
            invalid()
          continue
        }
      }
      const digest = createHash("sha256")
      const counts = families.map((family) => ({ family, records: 0 }))
      let ordinal = 0,
        records = 0,
        retainedNextSeq = 1
      let items: z.infer<typeof Item>[] = []
      const flush = async () => {
        if (!items.length) return
        const page = Page.parse({ version: 1, ordinal, items })
        if (retained) {
          if (!equal(await capture.read(pageKey(session.sessionID, generation, ordinal)), page)) invalid()
        } else await capture.write(pageKey(session.sessionID, generation, ordinal), page)
        digest.update(hash(page) + "\n")
        ordinal++
        items = []
      }
      for (const item of counts)
        for await (const entry of capture.rows(["organization", item.family, session.sessionID, String(generation)])) {
          capture.assert()
          if (item.family === "shared-events") {
            const event = Record.SharedEvent.parse(entry.value).event
            if (
              event.sequence !== retainedNextSeq ||
              !equal(entry.key, Keys.sharedEvent(session.sessionID, generation, retainedNextSeq))
            )
              invalid()
            retainedNextSeq++
          }
          items.push({
            family: item.family,
            key: entry.key,
            hash: hash(entry.value),
          })
          records++
          item.records++
          if (items.length === 128) await flush()
        }
      await flush()
      const root =
        retainedNextSeq > 1
          ? await load(Record.SharedSession, Keys.sharedSession(session.sessionID, generation, session.sessionID))
          : undefined
      if (retainedNextSeq > 1 !== !!root) invalid()
      const closed = Closed.parse({
        version: 1,
        identity: metadata(session),
        generation,
        revokedByGeneration: generation + 1,
        binding: {
          runtimeID: root?.projection.driverRuntimeID ?? session.driverRuntimeID,
          bindingEpoch: root?.projection.bindingEpoch ?? session.bindingEpoch,
        },
        proof: {
          kind: "retained-inventory",
          retainedNextSeq,
          origin: retained?.proof.kind === "retained-inventory" ? retained.proof.origin : capture.origin,
          observedAt: retained?.proof.kind === "retained-inventory" ? retained.proof.observedAt : capture.observedAt,
          families: counts,
          pages: ordinal,
          records,
          hash: digest.digest("hex"),
        },
      })
      inspect(closed, session)
      if (retained) {
        if (!equal(retained, closed)) invalid()
      } else await capture.write(key(session.sessionID, generation), closed)
    }
    capture.assert()
  }
  interface RetainedObservation {
    observedAt: number
    source: Record.HistoricalReader
    read(key: string[]): unknown | undefined
    append(key: string[], value: unknown): void
    assert(): void
  }
  export async function archived(input: RetainedObservation & { origin: ArchiveOrigin }) {
    const origin = Origin.parse(input.origin)
    if (origin.kind !== "archive-inventory") invalid()
    return observeInventory({ ...input, origin }, true)
  }
  export function observe(input: RetainedObservation) {
    return observeInventory({ ...input, origin: { kind: "home-maintenance" } }, false)
  }
  async function observeInventory(input: RetainedObservation & { origin: RetainedOrigin }, registration: boolean) {
    const origin = Origin.parse(input.origin)
    let additions = 0
    const capture: InventoryCapture = {
      origin,
      observedAt: input.observedAt,
      async *rows(prefix) {
        yield* input.source.entries(prefix)
      },
      async read(key) {
        input.assert()
        return input.read(key)
      },
      async write(key, value) {
        input.assert()
        input.append(key, value)
        additions++
      },
      assert: input.assert,
    }
    for (const row of input.source.entries(Keys.sessions())) {
      input.assert()
      const session = Record.SessionDirectory.parse(row.value)
      if (!equal(row.key, Keys.session(session.sessionID))) invalid()
      await retain(session, capture)
    }
    if (registration && additions) {
      const previous = input.read(schemaKey)
      if (previous !== undefined) Schema.parse(previous)
      input.assert()
      input.append(schemaKey, Schema.parse({ schemaVersion: 1 }))
    }
  }
  export const registrationKey = schemaKey
  export const Registration = Schema
  export async function upgrade(assert: () => void, progress: (current: number, total: number) => void) {
    await assertCoverage(assert)
    let count = 0
    for await (const row of Storage.records({
      prefix: Keys.sessions(),
      limit: 128,
    })) {
      assert()
      const session = Record.parse(Record.SessionDirectory, row.key, row.value)
      if (!equal(row.key, Keys.session(session.sessionID))) invalid()
      await Storage.transaction(
        async () => {
          assert()
          if (!equal(await Record.read(Record.SessionDirectory, row.key), session)) invalid()
          await retain(session, {
            origin: { kind: "home-maintenance" },
            observedAt: Date.now(),
            async *rows(prefix) {
              for await (const row of Storage.records({ prefix, limit: 128 })) {
                if (!prefix.every((part, index) => row.key[index] === part)) invalid()
                yield row
              }
            },
            async read(key) {
              return (await Storage.readMany([key]))[0]
            },
            write(key, value) {
              return Storage.write(key, value)
            },
            assert,
          })
        },
        { commitGuard: assert },
      )
      progress(++count, 0)
    }
    assert()
    await Storage.write(schemaKey, Schema.parse({ schemaVersion: 1 }))
    progress(count, count)
  }
}
