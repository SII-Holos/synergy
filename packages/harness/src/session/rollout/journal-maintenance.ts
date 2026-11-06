import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { Storage } from "../../storage/storage"
import { RecordCodec } from "../../storage/record-codec"
import { StorageIntegrityError } from "../../storage/errors"
import type { Migration } from "../../migration/types"
import { UpgradeWork } from "../../storage/upgrade-work"
import { RolloutArtifact } from "./artifact"
import { RolloutJournalCodec } from "./journal-codec"
import { RolloutSchema } from "./schema"

export namespace RolloutJournalMaintenance {
  export const id = "20261021-rollout-journal-contexts"
  const key = ["storage_maintenance", id]
  const State = z
    .object({
      version: z.literal(1),
      phase: z.enum(["pending", "running", "completed"]),
      kind: z.number().int().min(0).max(2),
      after: z.array(z.string()).optional(),
      owner: RolloutSchema.Owner.optional(),
      through: z.number().int().nonnegative(),
      next: z.number().int().positive(),
      rewritten: z.number().int().nonnegative(),
      encodedBefore: z.number().nonnegative(),
      encodedAfter: z.number().nonnegative(),
      backup: z.object({ file: z.string(), bytes: z.number().nonnegative(), sha256: z.string() }).optional(),
    })
    .strict()
  type State = z.infer<typeof State>
  const fresh = (): State => ({
    version: 1,
    phase: "pending",
    kind: 0,
    through: 0,
    next: 1,
    rewritten: 0,
    encodedBefore: 0,
    encodedAfter: 0,
  })
  export async function status(): Promise<State> {
    const [value] = await Storage.readMany([key])
    return value === undefined ? fresh() : State.parse(value)
  }
  export async function backup(value: NonNullable<State["backup"]>) {
    await Storage.write(key, { ...(await status()), backup: value })
  }
  const size = (value: unknown) => {
    const encoded = RecordCodec.encode(value, Storage.current().store.keyEncodedAs === "bytes" ? "frame" : "text")
    return typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength
  }
  async function nextOwner(state: State): Promise<State> {
    while (state.kind < 2) {
      const rows = await Storage.query<{ allocated: number; committed: number }>({
        kind: state.kind === 0 ? "rollout" : "operations",
        orderEquals: "head",
        after: state.after,
        limit: 64,
      })
      for (const row of rows) {
        state = { ...state, after: row.key }
        if (row.key.length !== 6 || row.key.slice(3).join("/") !== "rollout/journal/head") continue
        const owner = RolloutSchema.Owner.parse(
          state.kind === 0
            ? { kind: "session", scopeID: row.key[1], sessionID: row.key[2] }
            : { kind: "operation", scopeID: row.key[1], operationID: row.key[2] },
        )
        return State.parse({ ...state, owner, next: 1, through: row.value.committed })
      }
      if (rows.length < 64) state = { ...state, kind: state.kind + 1, after: undefined }
    }
    return { ...state, phase: "completed", owner: undefined }
  }
  async function page(state: State) {
    const root = [...RolloutArtifact.root(state.owner!), "journal", "events"]
    const keys = Array.from({ length: Math.min(128, state.through - state.next + 1) }, (_, i) => [
      ...root,
      String(state.next + i).padStart(12, "0"),
    ])
    const values = await Storage.readMany(keys)
    if (values.some((value) => value === undefined))
      throw new StorageIntegrityError("Missing committed rollout journal event")
    const events = await RolloutJournalCodec.decode(state.owner!, values)
    return events.map((event, index) => {
      if (event.seq !== state.next + index) throw new StorageIntegrityError("Rollout journal sequence mismatch")
      const original = values[index]
      const encoded = RolloutJournalCodec.encode(event)
      return {
        key: keys[index],
        event,
        original,
        encoded,
        rewrite: encoded.event.version === 2 && (original as { version: number }).version === 1,
      }
    })
  }
  export async function inspect(signal?: AbortSignal) {
    let state = fresh(),
      events = 0,
      legacyAttempts = 0,
      encodedBytes = 0
    for (;;) {
      signal?.throwIfAborted()
      if (!state.owner) state = await nextOwner(state)
      if (state.phase === "completed") break
      if (state.next > state.through) {
        state = { ...state, owner: undefined }
        continue
      }
      const batch = await page(state)
      for (const row of batch) {
        events++
        legacyAttempts += Number(row.rewrite)
        encodedBytes += size(row.original)
      }
      state.next += batch.length
    }
    return {
      writing: "context-v2",
      events,
      legacyAttempts,
      encodedBytes,
      maintenanceNeeded: legacyAttempts > 0,
      progress: await status(),
    }
  }
  export async function compact(
    options: { signal?: AbortSignal; progress?: (current: number, total: number) => void } = {},
  ) {
    let state = await status()
    while (state.phase !== "completed") {
      options.signal?.throwIfAborted()
      if (!state.owner) state = await nextOwner(state)
      if (state.phase === "completed") {
        await Storage.write(key, state)
        break
      }
      if (state.next > state.through) {
        state = { ...state, owner: undefined }
        continue
      }
      const rows = await page(state)
      const batch: typeof rows = []
      const contexts = new Map<string, NonNullable<(typeof rows)[number]["encoded"]["context"]>>()
      let bytes = size(state) + 32 * 1024
      for (const row of rows) {
        const context = row.rewrite ? row.encoded.context : undefined
        const added =
          (row.rewrite ? size(row.encoded.event) : 0) + (context && !contexts.has(context.id) ? size(context.value) : 0)
        if (bytes + added > 1024 * 1024) {
          if (!batch.length)
            throw new StorageIntegrityError("Rollout journal record exceeds the maintenance batch limit")
          break
        }
        batch.push(row)
        if (context) contexts.set(context.id, context)
        bytes += added
      }
      const owner = state.owner!
      const next = { ...state, phase: "running" as const, next: state.next + batch.length }
      await Storage.transaction(
        async (tx) => {
          const entries = [...contexts.values()]
          const existing = await Storage.readMany(
            entries.map((context) => RolloutJournalCodec.contextKey(owner, context.id)),
          )
          for (let i = 0; i < entries.length; i++) {
            options.signal?.throwIfAborted()
            if (existing[i] !== undefined) continue
            const context = entries[i]
            const time = batch.find((row) => row.encoded.context?.id === context.id)!.event.time
            await tx.insertHistorical(RolloutJournalCodec.contextKey(owner, context.id), context.value, time)
            next.encodedAfter += size(context.value)
          }
          const decoded = await RolloutJournalCodec.decode(
            owner,
            batch.map((row) => row.encoded.event),
          )
          for (let i = 0; i < batch.length; i++) {
            options.signal?.throwIfAborted()
            const row = batch[i]
            if (!isDeepStrictEqual(decoded[i], row.event))
              throw new StorageIntegrityError("Rollout journal compaction changed evidence")
            if (!row.rewrite) continue
            next.rewritten++
            next.encodedBefore += size(row.original)
            next.encodedAfter += size(row.encoded.event)
          }
          await tx.rewriteEncodings(
            batch
              .filter((row) => row.rewrite)
              .map((row) => ({ key: row.key, value: row.encoded.event, expected: row.original })),
          )
          await Storage.write(key, next)
          options.signal?.throwIfAborted()
        },
        { commitGuard: () => options.signal?.throwIfAborted() },
      )
      state = next
      options.progress?.(state.rewritten, 0)
    }
    return state
  }
  export const migration: Migration = {
    id,
    domain: "rollout-journal",
    scope: "derived",
    execution: "maintenance",
    description: "Deduplicate immutable Rollout attempt context without changing logical history",
    isApplied: async () => (await status()).phase === "completed",
    async up(progress) {
      const { StorageMaintenance } = await import("../../storage/maintenance")
      await StorageMaintenance.prepareRolloutBackup()
      await compact({ signal: UpgradeWork.signal(), progress })
    },
  }
}
