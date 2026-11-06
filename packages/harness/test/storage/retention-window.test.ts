import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityStore } from "../../src/observability/store"
import { SqliteMaintenance } from "../../src/storage/sqlite-maintenance"
import { Storage } from "../../src/storage/storage"
import { StorageRetention } from "../../src/storage/retention"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { clearObservabilityState, resetObservabilityState } from "../observability/fixture"

const DAY = 24 * 60 * 60 * 1000
const RETENTION = 7 * DAY
const FLOOR = StorageRetention.WINDOW_FLOOR_MS

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "retention-window-"))
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

// Random payloads are incompressible, so the bytes written are the bytes the
// store grows by; repeated padding would be zstd-framed and measure nothing.
async function writeEvidence(store: TransactionalStore, sessionID: string, megabytes: number) {
  await store.write(["sessions", "scope", sessionID, "info"], { id: sessionID })
  const records = Math.ceil((megabytes * 1024 * 1024) / 64_000)
  for (let index = 0; index < records; index++) {
    await store.write(["sessions", "scope", sessionID, "rollout", "runs", `run_${index}`, "info"], {
      pad: crypto.randomBytes(48_000).toString("base64"),
    })
  }
}

function ingressSample(store: TransactionalStore) {
  return store.readMany<{
    version: number
    footprintBytes: number
    releasedPages: number
    sampledAt: number
    ingressBytesPerMs?: number
  }>([StorageRetention.INGRESS_KEY])
}

async function runPass(input: {
  store: TransactionalStore
  filename: string
  maxBytes: number
  now: number
  liveSessionIDs?: string[]
}) {
  return Storage.provide({ store: input.store, artifactDirectory: path.dirname(input.filename) }, () =>
    StorageRetention.run({
      retentionMs: RETENTION,
      maxBytes: input.maxBytes,
      liveSessionIDs: input.liveSessionIDs ?? [],
      now: input.now,
    }),
  )
}

beforeEach(() =>
  runtime.run(() => {
    resetObservabilityState()
    ObservabilityStore.open()
  }),
)

afterEach(() =>
  runtime.run(() => {
    StorageRetention.stop()
    clearObservabilityState()
  }),
)

describe("derived retention window", () => {
  // Ingress equal to this fills the budget in exactly the configured window, so
  // a higher rate lands strictly between the floor and the configured window.
  const maxBytes = 1000 * RETENTION

  test("narrows as the measured ingress rate rises", () =>
    runtime.run(() => {
      const slow = StorageRetention.deriveWindow({ retentionMs: RETENTION, maxBytes, ingressBytesPerMs: 2000 })
      const fast = StorageRetention.deriveWindow({ retentionMs: RETENTION, maxBytes, ingressBytesPerMs: 4000 })

      expect(slow.windowMs).toBeCloseTo(RETENTION / 2, 8)
      expect(fast.windowMs).toBeCloseTo(RETENTION / 4, 8)
      expect(fast.windowMs).toBeLessThan(slow.windowMs)
      expect(Math.max(slow.windowMs, fast.windowMs)).toBeLessThanOrEqual(RETENTION)
      expect(slow.infeasible).toBe(false)
      expect(fast.infeasible).toBe(false)
    }))

  test("never drops below the floor, even when the budget cannot hold the floor", () =>
    runtime.run(() => {
      const derived = StorageRetention.deriveWindow({ retentionMs: RETENTION, maxBytes, ingressBytesPerMs: 10_000_000 })
      expect(derived.windowMs).toBe(FLOOR)
      expect(derived.floorMs).toBe(FLOOR)
      expect(derived.infeasible).toBe(true)
    }))

  test("keeps the configured window when no rate has been measured or none is positive", () =>
    runtime.run(() => {
      for (const ingressBytesPerMs of [undefined, 0, -1, Number.NaN]) {
        const derived = StorageRetention.deriveWindow({ retentionMs: RETENTION, maxBytes, ingressBytesPerMs })
        expect(derived.windowMs).toBe(RETENTION)
        expect(derived.infeasible).toBe(false)
      }
      const unbudgeted = StorageRetention.deriveWindow({ retentionMs: RETENTION, maxBytes: 0, ingressBytesPerMs: 5000 })
      expect(unbudgeted.windowMs).toBe(RETENTION)
      expect(unbudgeted.infeasible).toBe(false)
    }))

  test("a window configured below the floor keeps its own shorter promise", () =>
    runtime.run(() => {
      const configured = 6 * 60 * 60 * 1000
      const derived = StorageRetention.deriveWindow({
        retentionMs: configured,
        maxBytes: 100_000_000,
        ingressBytesPerMs: 0.5,
      })
      expect(derived.floorMs).toBe(configured)
      expect(derived.windowMs).toBe(configured)
      expect(derived.infeasible).toBe(false)

      // The floor follows the configured window down, so a budget under even that
      // shorter promise is the unreachable case rather than a lengthened window.
      const unreachable = StorageRetention.deriveWindow({
        retentionMs: configured,
        maxBytes: 1024,
        ingressBytesPerMs: 0.5,
      })
      expect(unreachable.windowMs).toBe(configured)
      expect(unreachable.infeasible).toBe(true)
    }))
})

describe("budget-derived window during a pass", () => {
  test("measures ingress from the footprint and the previously released pages, durably", () =>
    runtime.run(async () => {
      await using tmp = await fixture()
      const { store, filename } = tmp
      const now = Date.now()
      await writeEvidence(store, "ses_growth", 1)

      // The first over-budget pass has nothing to compare against, so it records
      // the footprint and leaves the configured window in force.
      const first = await runPass({ store, filename, maxBytes: 1, now: now - 30 * DAY })
      expect(first.ingressBytesPerMs).toBeUndefined()
      expect(first.effectiveWindowMs).toBe(RETENTION)
      expect(first.windowReduced).toBe(false)

      const [sample] = await ingressSample(store)
      // The sample records the footprint the pass measured, which is taken before
      // the pass writes the sample itself back into the store.
      expect(sample?.footprintBytes).toBe(first.footprintBytes)
      expect(SqliteMaintenance.physicalFootprint(filename)).toBeGreaterThanOrEqual(sample!.footprintBytes)
      expect(sample?.sampledAt).toBe(now - 30 * DAY)

      await writeEvidence(store, "ses_more", 1)
      const grown = SqliteMaintenance.physicalFootprint(filename)
      expect(grown).toBeGreaterThan(sample!.footprintBytes)

      const second = await runPass({ store, filename, maxBytes: Math.floor(grown / 2), now })
      // Δfootprint over the measured interval, with the previous pass's released
      // pages added back. That pass pruned nothing, so nothing is added back here.
      expect(second.ingressBytesPerMs).toBeCloseTo((grown - sample!.footprintBytes) / (30 * DAY), 8)
      expect(second.ingressBytesPerMs!).toBeGreaterThan(0)
    }))

  test("survives a restart by resuming the estimate the store holds", () =>
    runtime.run(async () => {
      await using tmp = await fixture()
      const { store, filename } = tmp
      const now = Date.now()
      await writeEvidence(store, "ses_before_restart", 1)
      await runPass({ store, filename, maxBytes: 1, now: now - 30 * DAY })
      await writeEvidence(store, "ses_after_restart", 1)
      const grown = SqliteMaintenance.physicalFootprint(filename)
      const measured = await runPass({ store, filename, maxBytes: Math.floor(grown / 2), now })
      expect(measured.ingressBytesPerMs).toBeGreaterThan(0)

      await store.close()
      const reopened = await TransactionalStore.open({ backend: "sqlite", namespace: "retention", filename })
      try {
        const resumed = await Storage.provide({ store: reopened, artifactDirectory: path.dirname(filename) }, () =>
          StorageRetention.run({ retentionMs: RETENTION, maxBytes: Math.floor(grown / 2), liveSessionIDs: [], now }),
        )
        // A restarted runtime reads the estimate out of the store rather than
        // re-learning it, so the derived window is in force on the first pass.
        expect(resumed.ingressBytesPerMs).toBe(measured.ingressBytesPerMs)
        expect(resumed.effectiveWindowMs).toBe(measured.effectiveWindowMs)
        expect(resumed.windowReduced).toBe(false)
      } finally {
        await reopened.close()
      }
    }))

  test("an over-budget store whose evidence is inside the window no longer reports infeasible", () =>
    runtime.run(async () => {
      await using tmp = await fixture()
      const { store, filename } = tmp
      const now = Date.now()
      await writeEvidence(store, "ses_recent", 1)

      const first = await runPass({ store, filename, maxBytes: 1, now: now - 30 * DAY })
      await writeEvidence(store, "ses_recent_more", 1)
      const grown = SqliteMaintenance.physicalFootprint(filename)
      // A budget this store is over, whose steady state the measured rate still
      // fits: the window stays the configured one and the pass must not claim the
      // budget is unreachable while deleting nothing.
      const budget = Math.floor(grown / 2)
      const second = await runPass({ store, filename, maxBytes: budget, now })
      const third = await runPass({ store, filename, maxBytes: budget, now })

      for (const pass of [first, second, third]) {
        expect(pass.infeasible).toBe(false)
        expect(pass.windowReduced).toBe(false)
        expect(pass.effectiveWindowMs).toBe(RETENTION)
        expect(pass.pruned).toEqual([])
        expect(pass.deletedRecords).toBe(0)
      }
      expect(second.capped).toBe(true)

      ObservabilityStore.flush()
      const issues = ObservabilityIssues.list({ module: "storage" })
      expect(issues.filter((issue) => issue.code === "STORAGE_RETENTION_BUDGET_INFEASIBLE")).toHaveLength(0)
    }))

  test("a budget that cannot hold the floor reports the named issue and prunes nothing", () =>
    runtime.run(async () => {
      await using tmp = await fixture()
      const { store, filename } = tmp
      const now = Date.now()
      await writeEvidence(store, "ses_older", 1)
      await runPass({ store, filename, maxBytes: 1, now: now - 30 * DAY })
      await writeEvidence(store, "ses_grown", 1)
      const grown = SqliteMaintenance.physicalFootprint(filename)
      await runPass({ store, filename, maxBytes: Math.floor(grown / 2), now })

      const [sample] = await ingressSample(store)
      const rate = sample!.ingressBytesPerMs!
      const budget = Math.max(1, Math.floor(rate * DAY) - 1)
      expect(budget).toBeGreaterThan(0)
      expect(budget).toBeLessThan(grown)

      const infeasible = await runPass({ store, filename, maxBytes: budget, now: now + 5 * DAY })

      expect(infeasible.infeasible).toBe(true)
      expect(infeasible.windowReduced).toBe(true)
      expect(infeasible.effectiveWindowMs).toBe(FLOOR)
      expect(infeasible.capped).toBe(true)
      expect(infeasible.pruned).toEqual([])
      expect(infeasible.deletedRecords).toBe(0)

      // The whole point of the floor: evidence far outside the shortest window is
      // still there, because a budget that cannot hold the floor buys nothing by
      // deleting below it.
      await expect(
        store.read(["sessions", "scope", "ses_older", "rollout", "runs", "run_0", "info"]),
      ).resolves.toMatchObject({ pad: expect.any(String) })

      ObservabilityStore.flush()
      const issues = ObservabilityIssues.list({ module: "storage" }).filter(
        (issue) => issue.code === "STORAGE_RETENTION_BUDGET_INFEASIBLE",
      )
      expect(issues).toHaveLength(1)
      expect(issues[0].evidence).toMatchObject({ maxBytes: budget, floorMs: FLOOR, effectiveWindowMs: FLOOR })
    }))

  test("retains the budget-derived window instead of the configured one, and reports the reduction", () =>
    runtime.run(async () => {
      await using tmp = await fixture()
      const { store, filename } = tmp
      const writtenAt = Date.now()
      await writeEvidence(store, "ses_budget_window", 1)

      // Two samples an interval apart establish a rate at which this budget holds
      // four days of evidence: under the configured seven, above the floor.
      await runPass({ store, filename, maxBytes: 1, now: writtenAt - 30 * DAY })
      await writeEvidence(store, "ses_budget_window_more", 1)
      const first = SqliteMaintenance.physicalFootprint(filename)
      await runPass({ store, filename, maxBytes: Math.floor(first / 2), now: writtenAt - 5 * DAY })
      const [sample] = await ingressSample(store)
      const rate = sample!.ingressBytesPerMs!
      expect(rate).toBeGreaterThan(0)

      await writeEvidence(store, "ses_budget_window_last", 1)
      const current = SqliteMaintenance.physicalFootprint(filename)
      const budget = Math.floor(rate * 4 * DAY)
      expect(budget).toBeGreaterThan(0)
      expect(budget).toBeLessThan(current)

      // Every owner wrote at `writtenAt`, which the configured 7-day window would
      // protect. The pass runs far enough ahead that only the derived 4-day window
      // decides what may be removed.
      const report = await runPass({ store, filename, maxBytes: budget, now: writtenAt + 30 * DAY })

      expect(report.windowReduced).toBe(true)
      expect(report.infeasible).toBe(false)
      expect(Math.abs(report.effectiveWindowMs - 4 * DAY)).toBeLessThan(5_000)
      expect(report.effectiveWindowMs).toBeLessThan(RETENTION)
      expect(report.effectiveWindowMs).toBeGreaterThanOrEqual(FLOOR)
      // The operative window is the derived one: evidence the configured window
      // protects is pruned because the budget cannot hold it.
      expect(report.deletedRecords).toBeGreaterThan(0)
      expect(report.pruned.length).toBeGreaterThan(0)

      ObservabilityStore.flush()
      const issues = ObservabilityIssues.list({ module: "storage" }).filter(
        (issue) => issue.code === "STORAGE_RETENTION_WINDOW_REDUCED",
      )
      expect(issues).toHaveLength(1)
      expect(issues[0].severity).toBe("warning")
      expect(issues[0].evidence).toMatchObject({ retentionMs: RETENTION, effectiveWindowMs: report.effectiveWindowMs })
    }))

  test("reports one window-reduction issue for a steady state instead of one per sweep", () =>
    runtime.run(async () => {
      await using tmp = await fixture()
      const { store, filename } = tmp
      const writtenAt = Date.now()
      await writeEvidence(store, "ses_steady", 1)

      // The estimate is seeded rather than measured so the sweeps are exactly the
      // repeats they are meant to be: an ingress that fills this budget in two
      // days, and a budget half the current footprint so every sweep is over it.
      const footprint = SqliteMaintenance.physicalFootprint(filename)
      const ingressBytesPerMs = footprint / (4 * DAY)
      const sampledAt = writtenAt
      await store.write(StorageRetention.INGRESS_KEY, {
        version: 1,
        footprintBytes: footprint,
        releasedPages: 0,
        sampledAt,
        ingressBytesPerMs,
      })
      const budget = Math.floor(ingressBytesPerMs * 2 * DAY)
      expect(budget).toBeGreaterThan(0)
      expect(budget).toBeLessThan(footprint)

      // One instant, repeated, with no writes between: each sweep measures no
      // growth, so every sweep reports the same reduction and prunes nothing
      // because the sole owner's newest record is inside both derived windows.
      const sweepAt = writtenAt + DAY
      const swept = []
      for (let sweep = 0; sweep < 3; sweep++)
        swept.push(await runPass({ store, filename, maxBytes: budget, now: sweepAt }))
      for (const pass of swept) {
        expect(pass.windowReduced).toBe(true)
        expect(pass.infeasible).toBe(false)
        expect(pass.capped).toBe(true)
        expect(pass.pruned).toEqual([])
        expect(pass.deletedRecords).toBe(0)
      }

      ObservabilityStore.flush()
      const issues = ObservabilityIssues.list({ module: "storage" }).filter(
        (issue) => issue.code === "STORAGE_RETENTION_WINDOW_REDUCED",
      )
      // One open issue per fingerprint: a steady state accumulates occurrences
      // rather than adding a row for every sweep of the same condition.
      expect(issues).toHaveLength(1)
      expect(issues[0].occurrenceCount).toBe(3)
    }))
})

afterRuntimeTests(() => runtime.close())
