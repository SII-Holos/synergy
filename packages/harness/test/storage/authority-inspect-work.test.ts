import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AuthorityJournal as Journal } from "../../src/storage/authority-journal"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { storageTestRuntime } from "../support/storage-runtime"
import { storageTestOptions } from "../support/storage-backends"

const Policy = z.strictObject({ enabled: z.boolean(), revision: z.number().int() })
const root = ["storage_authority_journal"]
const policyKey = (index: number) => ["policy", String(index).padStart(4, "0")]
const actor = {
  kind: "system" as const,
  subjectID: "authority-inspect-fixture",
  displayName: "Authority inspector",
  clientKind: "cli" as const,
  requestID: "recorded-late-change",
}

async function fixture() {
  const runtime = await storageTestRuntime()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "authority-inspect-work-"))
  const store = await TransactionalStore.open(
    storageTestOptions({ namespace: crypto.randomUUID(), filename: path.join(directory, "db") }),
  )
  const run = <T>(body: () => Promise<T>) =>
    runtime.run(() => Storage.provide({ store, artifactDirectory: path.join(directory, "content") }, body))
  try {
    await runtime.run(() =>
      Journal.register({
        id: "policy",
        version: 1,
        prefixes: [["policy"]],
        project: (_key, value) => Policy.parse(value),
      }),
    )
    await run(async () => {
      await Storage.transaction(async (tx) => {
        await tx.writeMany(
          Array.from({ length: 129 }, (_, index) => ({
            key: policyKey(index),
            value: { enabled: true, revision: 1 },
          })),
        )
      })
      await Journal.initialize({ namespaceID: "original-authority" })
    })
    return {
      run,
      store,
      async [Symbol.asyncDispose]() {
        await store.close()
        await runtime.close()
        await fs.rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await store.close()
    await runtime.close()
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function measuredInspection() {
  return Storage.snapshot(async (tx) => {
    const raw = tx.raw
    const query = raw.query
    const readMany = tx.readMany
    const work = { sql: 0, lookupSQL: 0, lookupKeys: 0, largestLookup: 0 }
    let reading = 0
    raw.query = <Row extends SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
      work.sql++
      if (reading) work.lookupSQL++
      const execute = query<Row>
      return execute.call(raw, statement, values, options)
    }
    tx.readMany = async <T = unknown>(keys: string[][]): Promise<(T | undefined)[]> => {
      work.lookupKeys += keys.length
      work.largestLookup = Math.max(work.largestLookup, keys.length)
      reading++
      try {
        const read = readMany<T>
        return await read.call(tx, keys)
      } finally {
        reading--
      }
    }
    try {
      return { result: await Journal.inspect(), work }
    } finally {
      raw.query = query
      tx.readMany = readMany
    }
  })
}

test("authority inspection bounds real lookup SQL while validating 129 original rows and their recorded change", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const baseline = await Journal.head()
    await Journal.transaction("policy.late-recorded-change", async (journal) => {
      journal.identify(actor)
      await Storage.write(policyKey(128), { enabled: false, revision: 2 })
    })
    const head = await Journal.head()
    const history = await Journal.entries({ limit: 1 })
    expect(head.baselineEntries).toBe(129)
    expect(head.baselineHash).toBe(baseline.baselineHash)
    expect(history.items).toHaveLength(1)
    expect(history.items[0]).toMatchObject({
      key: policyKey(128),
      previousHash: baseline.tailHash,
      after: { enabled: false, revision: 2 },
      hash: head.tailHash,
    })
    const observed = await measuredInspection()
    expect(observed.result).toEqual({ head, initialized: true, fingerprintGaps: 0, chainValid: true, covered: true })
    expect(await Storage.readMany([policyKey(0), policyKey(128)])).toEqual([
      { enabled: true, revision: 1 },
      { enabled: false, revision: 2 },
    ])
    expect(await Journal.head()).toEqual(head)
    // The head and three complete 129-key joins each use at most two actual SQL dispatches.
    expect(observed.work.lookupKeys).toBe(1 + 3 * 129)
    expect(observed.work.largestLookup).toBeLessThanOrEqual(128)
    expect(observed.work.lookupSQL).toBe(1 + 3 * Math.ceil(129 / 128))
    expect(observed.work.sql).toBeGreaterThan(observed.work.lookupSQL)
  })
}, 15000)

test("the original snapshot sees late policy changes, missing or malformed fingerprints and baseline damage", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const head = await Journal.head()
    const last = policyKey(128)
    const fingerprints = await Storage.query({ prefix: [...root, "fingerprints", head.journalID], limit: 129 })
    expect(fingerprints).toHaveLength(129)
    const finalFingerprint = fingerprints.at(-1)
    if (!finalFingerprint) throw new Error("The original late fingerprint is absent")
    const fingerprintKey = finalFingerprint.key
    const fingerprint = finalFingerprint.value
    const rollback = new Error("Original authority inspection rollback")
    const outcome = await Storage.transaction(async () => {
      expect((await Journal.inspect()).covered).toBeTrue()
      await Storage.write(last, { enabled: false, revision: 2 })
      await Storage.write([...root, "head"], head)
      const changed = await Journal.inspect()
      expect(changed.chainValid).toBeTrue()
      expect(changed.covered).toBeFalse()
      expect(changed.fingerprintGaps).toBeGreaterThan(0)
      throw rollback
    }).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )
    expect(outcome.kind).toBe("rejected")
    if (outcome.kind === "rejected") expect(outcome.error).toBe(rollback)
    expect(await Storage.read(last)).toEqual({ enabled: true, revision: 1 })
    expect((await Journal.inspect()).covered).toBeTrue()
    await Storage.remove(fingerprintKey)
    expect(await Journal.inspect()).toMatchObject({ chainValid: true, covered: false })
    await Storage.write(fingerprintKey, fingerprint)
    expect((await Journal.inspect()).covered).toBeTrue()
    const originalFingerprint = z
      .object({ domainID: z.string(), key: z.array(z.string()), hash: z.string() })
      .parse(fingerprint)
    await Storage.write(fingerprintKey, { ...originalFingerprint, hash: "malformed" })
    const malformed = await Journal.inspect().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(malformed).toBeInstanceOf(z.ZodError)
    await Storage.write(fingerprintKey, fingerprint)
    const baselineKey = [...root, "baseline", head.journalID, "0000000000000129"]
    const baseline = z
      .object({ fingerprint: z.record(z.string(), z.unknown()) })
      .passthrough()
      .parse(await Storage.read(baselineKey))
    await Storage.write(baselineKey, { ...baseline, fingerprint: { ...baseline.fingerprint, hash: "0".repeat(64) } })
    expect(await Journal.inspect()).toMatchObject({ chainValid: false, covered: false })
    await Storage.write(baselineKey, baseline)
    expect(await Journal.inspect()).toEqual({
      head,
      initialized: true,
      fingerprintGaps: 0,
      chainValid: true,
      covered: true,
    })
    const readFailure = new Error("Original lookup failed after its actual SQL dispatch")
    const failed = await Storage.snapshot(async (tx) => {
      const raw = tx.raw
      const query = raw.query
      let first = true
      raw.query = async <Row extends SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
        const execute = query<Row>
        const rows = await execute.call(raw, statement, values, options)
        if (first) {
          first = false
          throw readFailure
        }
        return rows
      }
      try {
        return await Journal.inspect()
      } finally {
        raw.query = query
      }
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failed).toBe(readFailure)
    expect((await Journal.inspect()).covered).toBeTrue()
    expect(await Journal.head()).toEqual(head)
  })
}, 15000)
