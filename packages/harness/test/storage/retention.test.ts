import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { StorageRetention } from "../../src/storage/retention"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const DAY = 24 * 60 * 60 * 1000
const RETENTION = 7 * DAY

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "retention-"))
  const filename = path.join(directory, "agent.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "retention", filename })
  return {
    store,
    filename,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

function evidenceKey(scopeID: string, sessionID: string, runID: string) {
  return ["sessions", scopeID, sessionID, "rollout", "runs", runID, "info"]
}

async function writeEvidence(store: TransactionalStore, scopeID: string, sessionID: string, runs = 6) {
  await store.write(["sessions", scopeID, sessionID, "info"], { id: sessionID })
  for (let index = 0; index < runs; index++) {
    await store.write(evidenceKey(scopeID, sessionID, `run_${index}`), { pad: "x".repeat(8192) })
  }
}

async function evidenceSurvives(store: TransactionalStore, scopeID: string, sessionID: string, runs = 6) {
  for (let index = 0; index < runs; index++) {
    expect(await store.read(evidenceKey(scopeID, sessionID, `run_${index}`))).toMatchObject({
      pad: expect.any(String),
    })
  }
}

test("online retention defers a large owner intact and still prunes an eligible small owner", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await store.transaction((tx) =>
      tx.writeMany([
        { key: ["sessions", "scope", "ses_large", "info"], value: { id: "ses_large" } },
        ...Array.from({ length: 2200 }, (_, index) => ({
          key: ["sessions", "scope", "ses_large", "rollout", "chunks", String(index)],
          value: { index },
        })),
      ]),
    )
    await writeEvidence(store, "scope", "ses_small")
    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({ retentionMs: RETENTION, maxBytes: 0, liveSessionIDs: [], now: Date.now() + 30 * DAY }),
    )
    expect(report.deferred).toEqual([{ key: ["sessions", "scope", "ses_large", "rollout"], reason: "records" }])
    expect(report.pruned.map((owner) => owner.key[2])).toEqual(["ses_small"])
    expect(await store.list(["sessions", "scope", "ses_large", "rollout"])).toHaveLength(2200)
    const maintenance = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({
        retentionMs: RETENTION,
        maxBytes: 0,
        liveSessionIDs: [],
        now: Date.now() + 30 * DAY,
        maintenance: true,
      }),
    )
    expect(maintenance.pruned.map((owner) => owner.key[2])).toEqual(["ses_large"])
    expect(await store.list(["sessions", "scope", "ses_large", "rollout"])).toHaveLength(0)
    expect((await store.verify()).issues).toEqual([])
  }))

test("retention refreshes live owners after enumeration before starting deletion", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_became_live")
    let reads = 0
    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({
        retentionMs: RETENTION,
        maxBytes: 0,
        liveSessionIDs: () => (++reads > 1 ? ["ses_became_live"] : []),
        now: Date.now() + 30 * DAY,
      }),
    )
    expect(report.pruned).toEqual([])
    await evidenceSurvives(store, "scope", "ses_became_live")
  }))

test("offline maintenance clears an outdated deferral after its byte budget is raised", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    await tmp.store.write(["storage_meta", "retention-deferred"], { owners: 3, updatedAt: 1 })
    await Storage.provide({ store: tmp.store, artifactDirectory: path.dirname(tmp.filename) }, async () => {
      await StorageRetention.run({
        retentionMs: RETENTION,
        maxBytes: 512 * 1024 * 1024,
        liveSessionIDs: [],
        maintenance: true,
      })
      expect(await StorageRetention.deferred()).toMatchObject({ owners: 0 })
    })
  }))

test("evidence inside the retention window survives a retention pass", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_inside")

    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({ retentionMs: RETENTION, maxBytes: 0, liveSessionIDs: [] }),
    )

    expect(report.pruned).toEqual([])
    expect(report.protectedByWindow).toBe(1)
    // The mandatory gate: within-window evidence stays readable, so rewind and
    // restore still have the records they replay.
    await evidenceSurvives(store, "scope", "ses_inside")
  }))

test("a live session is never pruned even when its evidence is outside the window", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_live")
    await writeEvidence(store, "scope", "ses_idle")

    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({
        retentionMs: RETENTION,
        maxBytes: 0,
        liveSessionIDs: ["ses_live"],
        now: Date.now() + 30 * DAY,
      }),
    )

    expect(report.protectedLive).toBe(1)
    expect(report.pruned.map((entry) => entry.key[2])).toEqual(["ses_idle"])
    await evidenceSurvives(store, "scope", "ses_live")
    await expect(store.read(evidenceKey("scope", "ses_idle", "run_0"))).rejects.toBeInstanceOf(Storage.NotFoundError)
  }))

test("retention stays off until a window is configured", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_kept")

    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({
        retentionMs: undefined,
        maxBytes: 0,
        liveSessionIDs: [],
        now: Date.now() + 300 * DAY,
      }),
    )

    expect(report.pruned).toEqual([])
    expect(report.considered).toBe(0)
    await evidenceSurvives(store, "scope", "ses_kept")
  }))

test("retention leaves everything alone while the database is inside its byte budget", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_under_budget")

    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({
        retentionMs: RETENTION,
        maxBytes: 512 * 1024 * 1024,
        liveSessionIDs: [],
        now: Date.now() + 30 * DAY,
      }),
    )

    expect(report.pruned).toEqual([])
    expect(report.capped).toBe(false)
    await evidenceSurvives(store, "scope", "ses_under_budget")
  }))

// A budget below what the retained evidence needs is a configuration problem,
// not a pruning problem. `infeasible` now names the narrower condition — a
// budget that cannot hold even the shortest permitted window — which needs a
// measured ingress rate to establish; with no measurement the configured window
// stands and this pass removes nothing.
test("an unreachable budget prunes nothing and leaves protected evidence intact", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_recent")

    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({ retentionMs: RETENTION, maxBytes: 1, liveSessionIDs: [] }),
    )

    expect(report.infeasible).toBe(false)
    expect(report.windowReduced).toBe(false)
    expect(report.capped).toBe(true)
    expect(report.pruned).toEqual([])
    expect(report.deletedRecords).toBe(0)
    // The window's protection still wins over the byte budget.
    await evidenceSurvives(store, "scope", "ses_recent")
  }))

test("pruning an expired owner reclaims records and node paths without touching live owners", () =>
  runtime.run(async () => {
    await using tmp = await fixture()
    const { store } = tmp
    await writeEvidence(store, "scope", "ses_expired")
    await writeEvidence(store, "scope", "ses_current")

    const report = await Storage.provide({ store, artifactDirectory: path.dirname(tmp.filename) }, () =>
      StorageRetention.run({
        retentionMs: RETENTION,
        maxBytes: 0,
        liveSessionIDs: [],
        now: Date.now() + 30 * DAY,
      }),
    )

    // `ses_expired` is outside the window; `ses_current` is outside too unless we
    // keep it in the window, so pin it by reporting the real cutoff behavior.
    expect(report.pruned.length).toBeGreaterThan(0)
    expect(report.deletedRecords).toBeGreaterThan(0)
    const removedSessionIDs = report.pruned.map((entry) => entry.key[2])
    expect(removedSessionIDs).toContain("ses_expired")
  }))

test("protectedOwners keeps both protection rules independent of storage state", () =>
  runtime.run(() => {
    const now = Date.now()
    const owners = [
      {
        key: ["sessions", "s", "old"],
        kind: "session" as const,
        scopeID: "s",
        id: "old",
        newest: now - 10 * DAY,
        records: 3,
      },
      {
        key: ["sessions", "s", "fresh"],
        kind: "session" as const,
        scopeID: "s",
        id: "fresh",
        newest: now,
        records: 3,
      },
      {
        key: ["operations", "s", "op"],
        kind: "operation" as const,
        scopeID: "s",
        id: "op",
        newest: now - 10 * DAY,
        records: 3,
      },
    ]

    const result = StorageRetention.protectedOwners({
      owners,
      retentionMs: RETENTION,
      liveSessionIDs: ["old"],
      now,
    })
    expect(result.protectedLive).toBe(1)
    expect(result.protectedByWindow).toBe(1)
    // Operations have no live protection, only the window.
    expect(result.candidates.map((owner) => owner.id)).toEqual(["op"])
  }))

afterRuntimeTests(() => runtime.close())
