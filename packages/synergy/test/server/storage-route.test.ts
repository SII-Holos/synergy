import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Hono } from "hono"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { GlobalStorageRoute } from "../../src/server/storage-route"
import { tmpdir } from "../fixture/fixture"

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

describe("GlobalStorageRoute", () => {
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
        const dryReports = (await dry.json()) as CleanReport[]
        const dryReport = dryReports.find((entry) => entry.scopeID === scope.id)!
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
        const appliedReports = (await applied.json()) as CleanReport[]
        const appliedReport = appliedReports.find((entry) => entry.scopeID === scope.id)!
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
})
