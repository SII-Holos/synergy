import { expect, spyOn, test } from "bun:test"
import { isDeepStrictEqual } from "node:util"
import { migrationFixture } from "../migration/fixture"
import { Storage } from "../../src/storage/storage"
import { StoreTransaction, TransactionalStore } from "../../src/storage/transactional-store"
import { RuntimeContext } from "../../src/lifecycle/context"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutJournalMaintenance } from "../../src/session/rollout/journal-maintenance"

test("bounded historical compaction resumes after reopening without changing evidence, revisions or retention age", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const owner = { kind: "operation" as const, scopeID: "fixture", operationID: "compact" }
    const root = RolloutArtifact.root(owner)
    const artifact = await RolloutArtifact.writeText(owner, "retained bytes")
    const id = crypto.randomUUID()
    const key = ["runs", "run", "attempts", "call", id]
    const events = Array.from({ length: 130 }, (_, i) => ({
      version: 1,
      kind: "record",
      seq: i + 1,
      time: 1000 + i,
      key,
      value: {
        version: 1,
        id,
        callID: "call",
        runID: "run",
        owner,
        index: 0,
        url: "https://fixture.invalid/" + "metadata".repeat(150),
        method: "POST",
        started: 1000,
        request: artifact,
        status: i === 129 ? "completed" : "running",
        ...(i === 129 ? { ended: 1130 } : {}),
        response: { ...artifact, bytes: i },
      },
    }))
    await Storage.transaction(async (tx) => {
      for (const event of events)
        await tx.insertHistorical(
          [...root, "journal", "events", String(event.seq).padStart(12, "0")],
          event,
          event.time,
        )
      await Storage.write([...root, "journal", "head"], { allocated: 130, committed: 130 })
      await Storage.write([...root, ...key], events.at(-1)!.value)
    })
    const before = await Array.fromAsync(RolloutJournal.events(owner, 130))
    expect(await RolloutJournalMaintenance.inspect()).toMatchObject({ legacyAttempts: 130 })
    {
      const rewrite = StoreTransaction.prototype.rewriteEncodings
      using failure = spyOn(StoreTransaction.prototype, "rewriteEncodings").mockImplementation(async function (
        this: StoreTransaction,
        entries,
      ) {
        expect(entries.length).toBeLessThanOrEqual(128)
        await rewrite.call(this, entries)
        throw new Error("interrupted batch publication")
      })
      await expect(RolloutJournalMaintenance.compact()).rejects.toThrow("interrupted batch publication")
      expect((await RolloutJournalMaintenance.status()).rewritten).toBe(0)
      expect(await Storage.scan([...root, "journal", "contexts"])).toEqual([])
      expect(await Array.fromAsync(RolloutJournal.events(owner, 130))).toEqual(before)
    }
    const controller = new AbortController()
    await expect(
      RolloutJournalMaintenance.compact({ signal: controller.signal, progress: () => controller.abort() }),
    ).rejects.toThrow()
    const state = await RolloutJournalMaintenance.status()
    expect(state.rewritten).toBe(128)
    expect(isDeepStrictEqual(await Array.fromAsync(RolloutJournal.events(owner, 130)), before)).toBe(true)
    const original = Storage.current()
    await original.store.close()
    const reopened = await TransactionalStore.open(original.store.options)
    RuntimeContext.current().storage = { ...original, store: reopened }
    try {
      const result = await RolloutJournalMaintenance.compact()
      expect(result).toMatchObject({ phase: "completed", rewritten: 130 })
      expect(await RolloutJournalMaintenance.compact()).toEqual(result)
      expect(await RolloutJournalMaintenance.inspect()).toMatchObject({ legacyAttempts: 0 })
      expect(await Array.fromAsync(RolloutJournal.events(owner, 130))).toEqual(before)
      expect(await Storage.read([...root, ...key])).toEqual(events.at(-1)!.value)
      expect((await Storage.versioned([...root, "journal", "events", "000000000001"])).revision).toBe(1n)
      const rows = await Storage.snapshot((tx) =>
        tx.raw.query<{ updated: number }>("SELECT updated FROM storage_records WHERE namespace = ? AND key_text = ?", [
          reopened.options.namespace,
          JSON.stringify([...root, "journal", "events", "000000000001"]),
        ]),
      )
      expect(Number(rows[0].updated)).toBe(1000)
      expect(Buffer.concat(await Array.fromAsync(RolloutArtifact.read(owner, artifact))).toString()).toBe(
        "retained bytes",
      )
    } finally {
      await reopened.close()
    }
  })
})
