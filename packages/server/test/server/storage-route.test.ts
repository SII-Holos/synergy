import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Hono } from "hono"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { Storage, SessionCompat, TransactionalStore } from "@ericsanchezok/synergy-harness/persistence"
import { StorageCompat } from "@ericsanchezok/synergy-harness/storage/compat"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { SnapshotLifecycle } from "@ericsanchezok/synergy-harness/session/snapshot-lifecycle"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { GlobalStorageRoute } from "../../src/server/storage-route"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

function app() {
  return new Hono().route("/global/storage", GlobalStorageRoute)
}

async function makeLegacyRepo(scopeID: string, sessionID: string) {
  const repo = SnapshotStore.legacyRepository(scopeID, sessionID)
  await SnapshotStore.initializeBareRepository(repo)
  return repo
}

interface UsageReport {
  scopeID: string
  owners: { legacy: number; shared: number; deleted: number }
  retainedLegacy: { unowned: number; reclaimed: number; sharedBaselines: number; unregistered: number }
  legacy: { bytes: number; allocatedBytes: number; files: number }
  shared: { bytes: number; allocatedBytes: number; files: number }
  indexes: { bytes: number; allocatedBytes: number; files: number }
}

interface CleanReport {
  scopeID: string
  applied: boolean
  candidates: Array<{ sessionID: string; bytes: number; reason: string }>
  removed: number
  bytes: number
  skippedProtected: number
  errors: string[]
}

interface CleanFailure {
  scopeID: string
  message: string
}

interface CleanBatch {
  results: CleanReport[]
  failures: CleanFailure[]
}

interface MigrationResult {
  sessionID: string
  status: "pending" | "migrated" | "skipped" | "failed"
  reason?: string
  objectsAdded?: number
}

interface MigrateReport {
  scopeID: string
  applied: boolean
  results: MigrationResult[]
}

interface CompactStatistics {
  bytes: number
  allocatedBytes: number
  files: number
}

interface CompactReport {
  scopeID: string
  applied: boolean
  prune: boolean
  before: CompactStatistics
  after?: CompactStatistics
  recoveredObjects?: number
}

interface MigrateBatch {
  results: MigrateReport[]
  failures: CleanFailure[]
}

interface CompactBatch {
  results: CompactReport[]
  failures: CleanFailure[]
}

describe("GlobalStorageRoute", () => {
  test("pause and resume persist independently of database readiness", async () => {
    const store = Storage.current().store
    await store.maintainDdlTransaction([
      {
        statement:
          "CREATE TABLE IF NOT EXISTS storage_format_v3_state(namespace TEXT PRIMARY KEY, state TEXT NOT NULL)",
      },
    ])
    await store.transaction((tx) =>
      tx.raw.query("INSERT INTO storage_format_v3_state(namespace, state) VALUES (?, ?)", [
        store.options.namespace,
        JSON.stringify({ version: 3, phase: "reclaim", recordsCursor: "", nodesCursor: "", artifactsCursor: "" }),
      ]),
    )
    try {
      for (const action of ["pause", "resume"] as const) {
        const response = await app().request("/global/storage/reclaim/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          format: { current: 3, maintenanceRequired: false },
          reclaim: { pending: true, paused: action === "pause" },
        })
        const read = await app().request("/global/storage/maintenance")
        expect(await read.json()).toMatchObject({ reclaim: { pending: true, paused: action === "pause" } })
      }
    } finally {
      await store.transaction((tx) =>
        tx.raw.query("DELETE FROM storage_format_v3_state WHERE namespace = ?", [store.options.namespace]),
      )
    }
  })
  test("maintenance status is independent of historical preparation and rejects invalid reclaim controls", async () => {
    const response = await app().request("/global/storage/maintenance")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      format: { current: 3, target: 3, maintenanceRequired: false },
      reclaim: { pending: false, running: false },
    })
    const invalid = await app().request("/global/storage/reclaim/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rewrite" }),
    })
    expect(invalid.status).toBe(400)
  })
  test("GET snapshot reports the per-scope usage shape", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await makeLegacyRepo(scope.id, "ses_routeUnowned01")
        const response = await app().request("/global/storage/snapshot")
        expect(response.status).toBe(200)
        const usage = (await response.json()) as UsageReport[]
        expect(Array.isArray(usage)).toBe(true)
        const mine = usage.find((entry) => entry.scopeID === scope.id)
        expect(mine).toBeDefined()
        expect(mine!.retainedLegacy.unowned).toBeGreaterThanOrEqual(1)
        expect(mine!.legacy.files).toBeGreaterThan(0)
        expect(mine!.owners).toEqual({ legacy: 0, shared: 0, deleted: 0 })
      },
    })
  })

  test("POST snapshot/clean defaults to dry-run; apply protects owner and session records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const unowned = "ses_routeUnowned02"
        const owned = "ses_routeOwned002"
        const hasSession = "ses_routeSession2"
        await makeLegacyRepo(scope.id, unowned)
        await makeLegacyRepo(scope.id, owned)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, owned), { version: 2, backend: "legacy" })
        await makeLegacyRepo(scope.id, hasSession)
        await Storage.write(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(hasSession)),
          {
            id: hasSession,
            scope: { directory: "/tmp/storage-route-fixture" },
            title: "kept",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        )

        const dry = await app().request("/global/storage/snapshot/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id }),
        })
        expect(dry.status).toBe(200)
        const dryReports = (await dry.json()) as CleanBatch
        const dryReport = dryReports.results.find((entry) => entry.scopeID === scope.id)!
        expect(dryReport.applied).toBe(false)
        expect(dryReport.candidates.map((entry) => entry.sessionID)).toEqual([unowned])
        expect(dryReport.candidates[0]!.reason).toBe("unowned")
        expect(dryReport.removed).toBe(0)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, unowned), "HEAD")).exists()).toBe(true)

        const applied = await app().request("/global/storage/snapshot/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id, apply: true }),
        })
        expect(applied.status).toBe(200)
        const appliedReports = (await applied.json()) as CleanBatch
        const appliedReport = appliedReports.results.find((entry) => entry.scopeID === scope.id)!
        expect(appliedReport.applied).toBe(true)
        expect(appliedReport.removed).toBe(1)
        expect(appliedReport.skippedProtected).toBe(2)
        await expect(fs.access(path.join(SnapshotStore.legacyRepository(scope.id, unowned)))).rejects.toThrow()
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, owned), "HEAD")).exists()).toBe(true)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, hasSession), "HEAD")).exists()).toBe(
          true,
        )
      },
    })
  })

  test("POST snapshot/clean apply returns 409 when the scope fails its integrity check", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(path.join(tmp.path, "a.txt"), "retained")
        await Snapshot.track(session.id)
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID("message-route"),
            Identifier.asPartID("part-route"),
          ),
          { type: "step-start", snapshot: "a".repeat(40) },
        )
        const orphan = "ses_routeUnowned03"
        await makeLegacyRepo(scope.id, orphan)

        const response = await app().request("/global/storage/snapshot/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id, apply: true }),
        })
        expect(response.status).toBe(409)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, orphan), "HEAD")).exists()).toBe(true)
      },
    })
  })

  test("POST snapshot/clean keeps __reclaimed__ directories that have session records", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await fs.rm(path.join(Global.Path.snapshot, "__reclaimed__"), { recursive: true, force: true })
        await Storage.removeTree(["sessions", Identifier.asScopeID("__reclaimed__")])
        const kept = "ses_routeKeptRc01"
        const recordless = "ses_routeRcOrph01"
        await makeLegacyRepo("__reclaimed__", kept)
        await makeLegacyRepo("__reclaimed__", recordless)
        await Storage.write(
          StoragePath.sessionInfo(Identifier.asScopeID("__reclaimed__"), Identifier.asSessionID(kept)),
          {
            id: kept,
            scope: { directory: "/tmp/storage-route-fixture" },
            title: "kept reclaimed session",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        )

        const applied = await app().request("/global/storage/snapshot/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: "__reclaimed__", apply: true }),
        })
        expect(applied.status).toBe(200)
        const reports = (await applied.json()) as CleanBatch
        const report = reports.results.find((entry) => entry.scopeID === "__reclaimed__")!
        expect(report.applied).toBe(true)
        expect(report.candidates.map((entry) => entry.sessionID)).toEqual([recordless])
        expect(report.removed).toBe(1)
        expect(report.skippedProtected).toBe(1)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository("__reclaimed__", kept), "HEAD")).exists()).toBe(
          true,
        )
        await expect(fs.access(SnapshotStore.legacyRepository("__reclaimed__", recordless))).rejects.toThrow()
      },
    })
  })
  test("POST snapshot/clean rejects an empty scopeID instead of targeting every scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const unowned = "ses_routeUnowned04"
        await makeLegacyRepo(scope.id, unowned)

        const response = await app().request("/global/storage/snapshot/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: "", apply: true }),
        })
        expect(response.ok).toBe(false)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, unowned), "HEAD")).exists()).toBe(true)
      },
    })
  })

  test("POST snapshot/clean batch keeps completed results when a later scope fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(path.join(tmp.path, "a.txt"), "retained")
        await Snapshot.track(session.id)
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID("message-route"),
            Identifier.asPartID("part-route"),
          ),
          { type: "step-start", snapshot: "a".repeat(40) },
        )
        const corrupted = "ses_routeUnowned05"
        await makeLegacyRepo(scope.id, corrupted)
        const healthy = "ses_routeUnowned06"
        await makeLegacyRepo("aaa_routeHealthy01", healthy)

        const response = await app().request("/global/storage/snapshot/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apply: true }),
        })
        expect(response.status).toBe(200)
        const batch = (await response.json()) as CleanBatch
        const failure = batch.failures.find((entry) => entry.scopeID === scope.id)
        expect(failure).toBeDefined()
        expect(batch.results.find((entry) => entry.scopeID === "aaa_routeHealthy01")?.removed).toBe(1)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, corrupted), "HEAD")).exists()).toBe(
          true,
        )
        await expect(fs.access(SnapshotStore.legacyRepository("aaa_routeHealthy01", healthy))).rejects.toThrow()
      },
    })
  })

  test("releaseOrphanOwners releases legacy owners without session records and keeps the rest", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const orphan = "ses_orphanRel01"
        const kept = "ses_orphanKeep01"
        const journalled = "ses_orphanJrn01"
        for (const sessionID of [orphan, kept, journalled]) {
          await makeLegacyRepo(scope.id, sessionID)
          await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, sessionID), {
            version: 2,
            backend: "legacy",
          })
        }
        await Storage.write(StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(kept)), {
          id: kept,
          scope: { directory: "/tmp/storage-route-fixture" },
          title: "kept",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
        })
        await SnapshotStore.write(StoragePath.snapshotMigration(scope.id, journalled), {
          version: 2,
          phase: "inventoried",
        })

        await SnapshotMaintenance.releaseOrphanOwners()

        expect(await SnapshotStore.owner(scope.id, orphan)).toBeUndefined()
        expect(await SnapshotStore.owner(scope.id, kept)).toBeDefined()
        expect(await SnapshotStore.owner(scope.id, journalled)).toBeDefined()
        for (const sessionID of [orphan, kept, journalled])
          expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, sessionID), "HEAD")).exists()).toBe(
            true,
          )
      },
    })
  })

  test("POST snapshot/migrate defaults to a dry run and reports pending legacy owners", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const pending = "ses_routeMigPend01"
        await makeLegacyRepo(scope.id, pending)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, pending), { version: 2, backend: "legacy" })

        const response = await app().request("/global/storage/snapshot/migrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id }),
        })
        expect(response.status).toBe(200)
        const batch = (await response.json()) as MigrateBatch
        const report = batch.results.find((entry) => entry.scopeID === scope.id)!
        expect(report.applied).toBe(false)
        expect(report.results.map((entry) => entry.sessionID)).toEqual([pending])
        expect(report.results[0]!.status).toBe("pending")
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, pending), "HEAD")).exists()).toBe(true)
      },
    })
  })

  test("POST snapshot/migrate moves an owned legacy repository into the shared store", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const migrating = "ses_routeMigrate01"
        await makeLegacyRepo(scope.id, migrating)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, migrating), { version: 2, backend: "legacy" })
        await Storage.write(
          StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(migrating)),
          {
            id: migrating,
            scope: { directory: "/tmp/storage-route-fixture" },
            title: "migrating",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        )

        const response = await app().request("/global/storage/snapshot/migrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id, apply: true }),
        })
        expect(response.status).toBe(200)
        const batch = (await response.json()) as MigrateBatch
        const report = batch.results.find((entry) => entry.scopeID === scope.id)!
        expect(report.applied).toBe(true)
        expect(report.results.map((entry) => entry.status)).toEqual(["migrated"])
        expect((await SnapshotStore.owner(scope.id, migrating))?.backend).toBe("shared")
        expect(await Bun.file(path.join(SnapshotStore.repository(scope.id), "HEAD")).exists()).toBe(true)
        await expect(fs.access(SnapshotStore.legacyRepository(scope.id, migrating))).rejects.toThrow()
      },
    })
  })

  test("POST snapshot/compact reports shared-store statistics without applying", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const response = await app().request("/global/storage/snapshot/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id }),
        })
        expect(response.status).toBe(200)
        const batch = (await response.json()) as CompactBatch
        const report = batch.results.find((entry) => entry.scopeID === scope.id)!
        expect(report.applied).toBe(false)
        expect(report.prune).toBe(false)
        expect(report.before.files).toBe(0)
      },
    })
  })

  test("POST snapshot/compact apply is a no-op without a shared store", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const response = await app().request("/global/storage/snapshot/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id, apply: true }),
        })
        expect(response.status).toBe(200)
        const batch = (await response.json()) as CompactBatch
        const report = batch.results.find((entry) => entry.scopeID === scope.id)!
        expect(report.applied).toBe(false)
      },
    })
  })
  test("POST snapshot/migrate and compact reject an empty scopeID", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const pending = "ses_routeMigPend02"
        await makeLegacyRepo(scope.id, pending)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, pending), { version: 2, backend: "legacy" })

        const migrateResponse = await app().request("/global/storage/snapshot/migrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: "", apply: true }),
        })
        expect(migrateResponse.ok).toBe(false)
        const compactResponse = await app().request("/global/storage/snapshot/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: "", apply: true }),
        })
        expect(compactResponse.ok).toBe(false)
        expect(await Bun.file(path.join(SnapshotStore.legacyRepository(scope.id, pending), "HEAD")).exists()).toBe(true)
      },
    })
  })

  test("POST snapshot/compact apply recovers pending deletions before packing", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const deleting = "ses_routeCompactDel01"
        await makeLegacyRepo(scope.id, deleting)
        await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, deleting), { version: 2, backend: "legacy" })
        await Storage.write(StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(deleting)), {
          id: deleting,
          scope: { directory: "/tmp/storage-route-fixture" },
          title: "deleting",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
        })
        await SnapshotStore.initializeRepository(scope.id)
        await SnapshotLifecycle.beginDelete(scope.id, deleting)
        expect(await SnapshotStore.optional(StoragePath.snapshotDeletion(scope.id, deleting))).toBeDefined()

        const response = await app().request("/global/storage/snapshot/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopeID: scope.id, apply: true, prune: true }),
        })
        expect(response.status).toBe(200)
        expect(await SnapshotStore.optional(StoragePath.snapshotDeletion(scope.id, deleting))).toBeUndefined()
      },
    })
  })
})

test("upgrade status is available independently of history and the catalog validates bounds", async () => {
  const response = await GlobalStorageRoute.request("http://localhost/upgrade")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ready: true,
    historyReady: true,
    paused: false,
    backup: { complete: true },
    pending: 0,
    partial: 0,
    imported: 0,
    quarantined: 0,
    total: 0,
  })
  const invalid = await GlobalStorageRoute.request("http://localhost/upgrade/sessions?limit=101")
  expect(invalid.status).toBe(400)
  const page = await GlobalStorageRoute.request("http://localhost/upgrade/sessions?limit=1")
  expect(await page.json()).toEqual({ items: [] })
})

test("history controls validate actions and per-session preparation returns without a long request", async () => {
  const request = (action: string) =>
    GlobalStorageRoute.request("http://localhost/upgrade/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
  expect((await request("unknown")).status).toBe(400)
  expect(await (await request("pause")).json()).toMatchObject({ paused: true, pauseReason: "user", ready: true })
  expect(await (await request("resume")).json()).toMatchObject({ paused: false })
  expect(
    await (
      await GlobalStorageRoute.request("http://localhost/upgrade/sessions/new/prepare", { method: "POST" })
    ).json(),
  ).toMatchObject({ sessionID: "new", state: "ready" })
})

async function withHistoricalSessions(
  body: (fixture: { store: TransactionalStore; data: string; ids: string[] }) => Promise<void>,
) {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const ids = [Identifier.ascending("session"), Identifier.ascending("session")]
  for (const [index, id] of ids.entries()) {
    await Bun.write(
      path.join(data, "sessions", "home", id, "info.json"),
      JSON.stringify({
        id,
        scope: { id: "home", type: "home" },
        title: `History ${index}`,
        version: "3.0.22",
        time: { created: index + 1, updated: index + 2 },
        completionNotice: { unread: false, silent: false, unreadCount: 0 },
      }),
    )
  }
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: crypto.randomUUID(),
    filename: path.join(tmp.path, "target.sqlite"),
  })
  try {
    await StorageCompat.seedLocators(store, data)
    await Storage.provide({ store, artifactDirectory: data }, async () => {
      try {
        await body({ store, data, ids })
      } finally {
        await SessionCompat.drain()
      }
    })
  } finally {
    await store.close()
  }
}

test("historical status and paginated catalog remain read-only, while foreground preparation works during pause", async () => {
  await withHistoricalSessions(async ({ store, data, ids }) => {
    const [first, second] = ids
    const status = await GlobalStorageRoute.request(`/upgrade/sessions/${first}`)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ sessionID: first, state: "pending", files: 0, bytes: 0 })
    const page = await (await GlobalStorageRoute.request("/upgrade/sessions?scopeID=home&limit=1")).json()
    expect(page.items).toEqual([{ sessionID: second, scopeID: "home", status: "pending" }])
    const query = new URLSearchParams({ scopeID: "home", limit: "1" })
    for (const part of page.next) query.append("after", part)
    expect(await (await GlobalStorageRoute.request(`/upgrade/sessions?${query}`)).json()).toMatchObject({
      items: [{ sessionID: first, scopeID: "home", status: "pending" }],
    })
    expect(await (await GlobalStorageRoute.request("/upgrade/sessions?scopeID=other")).json()).toEqual({ items: [] })
    expect((await StorageCompat.readLocator(store, first))?.status).toBe("pending")
    expect(await Bun.file(path.join(data, "sessions", "home", first!, "info.json")).exists()).toBe(true)

    const paused = await GlobalStorageRoute.request("/upgrade/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    })
    expect(await paused.json()).toMatchObject({ ready: true, historyReady: false, paused: true, pending: 2 })
    const requests = await Promise.all(
      Array.from({ length: 3 }, () =>
        GlobalStorageRoute.request(`/upgrade/sessions/${first}/prepare`, { method: "POST" }),
      ),
    )
    for (const response of requests) {
      expect(response.status).toBe(200)
      expect(["pending", "preparing", "ready"]).toContain((await response.json()).state)
    }
    await SessionCompat.drain()
    expect(await (await GlobalStorageRoute.request(`/upgrade/sessions/${first}`)).json()).toMatchObject({
      state: "ready",
    })
    expect(await (await GlobalStorageRoute.request("/upgrade")).json()).toMatchObject({
      paused: true,
      historyReady: false,
      pending: 1,
      imported: 1,
      total: 2,
    })
    expect((await StorageCompat.readLocator(store, second!))?.status).toBe("pending")
    expect(await store.read(["sessions", "home", first!, "info"])).toMatchObject({ title: "History 0" })
    expect((await store.verify()).issues).toEqual([])
  })
})

test("retry resumes failed preparation, preserves unrelated history and cannot bypass quarantine", async () => {
  await withHistoricalSessions(async ({ store, data, ids }) => {
    const [first, second] = ids
    const locator = await StorageCompat.readLocator(store, first!)
    await StorageCompat.writeLocator(store, {
      ...locator!,
      error: { category: "retryable", message: "Temporary storage failure" },
      retryAfter: Date.now() + 60_000,
    })
    expect(
      await (await GlobalStorageRoute.request(`/upgrade/sessions/${first}/prepare`, { method: "POST" })).json(),
    ).toMatchObject({
      state: "failed",
      error: { category: "retryable" },
    })
    expect(await Bun.file(path.join(data, "sessions", "home", first!, "info.json")).exists()).toBe(true)
    const retried = await GlobalStorageRoute.request(`/upgrade/sessions/${first}/retry`, { method: "POST" })
    expect(retried.status).toBe(200)
    await SessionCompat.drain()
    expect(await (await GlobalStorageRoute.request(`/upgrade/sessions/${first}`)).json()).toMatchObject({
      state: "ready",
    })
    expect(await StorageCompat.readLocator(store, first!)).toMatchObject({ status: "imported" })

    const source = path.join(data, "sessions", "home", second!, "info.json")
    await Bun.write(source, "{broken original")
    await GlobalStorageRoute.request(`/upgrade/sessions/${second}/prepare`, { method: "POST" })
    await SessionCompat.drain()
    const blocked = await (await GlobalStorageRoute.request(`/upgrade/sessions/${second}`)).json()
    expect(blocked).toMatchObject({ state: "blocked" })
    expect(
      await (await GlobalStorageRoute.request(`/upgrade/sessions/${second}/retry`, { method: "POST" })).json(),
    ).toEqual(blocked)
    expect(await Bun.file(source).text()).toBe("{broken original")
    expect(await (await GlobalStorageRoute.request("/upgrade")).json()).toMatchObject({
      ready: true,
      historyReady: false,
      imported: 1,
      quarantined: 1,
      pending: 0,
    })
    expect(await store.read(["sessions", "home", first!, "info"])).toMatchObject({ title: "History 0" })
  })
})
