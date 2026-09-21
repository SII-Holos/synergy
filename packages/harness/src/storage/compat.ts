import fs from "node:fs/promises"
import path from "node:path"
import { StorageIntegrityError } from "./errors"
import { legacyRecords } from "./legacy-source"
import type { TransactionalStore, StoreTransaction } from "./transactional-store"

/**
 * Storage-layer primitives for the phased activation contract: the session
 * aggregate tree (`data/sessions/**`) stays in legacy JSON after the SQLite
 * authority activates, and is imported per aggregate later. Everything outside
 * that tree keeps the #1393 invariant — no legacy record may survive
 * activation, and any record that reappears afterwards is a foreign writer.
 */
export namespace StorageCompat {
  const deferredRoot = "sessions"
  const locatorRoot = ["compat_import", "sessions"]
  const fileCheckpointRoot = (sessionID: string) => ["compat_import", "files", sessionID]

  /** Marks manifests that activated with deferred session aggregates. */
  export const boundary = "20260919-session-deferred-import"

  export interface Locator {
    sessionID: string
    scopeID: string
    status: "pending" | "partial" | "imported" | "quarantined"
    /** Data-relative path of the record that triggered a quarantine. */
    source?: string
    staged?: boolean
    retiring?: boolean
    failures?: number
    retryAfter?: number
    activity?: number
    phase?: "backup" | "import" | "migrate" | "verify" | "publish" | "complete"
    files?: number
    bytes?: number
    error?: { category: "retryable" | "integrity" | "data"; message: string }
  }

  export function deferRelative(relative: string) {
    return relative === deferredRoot || relative.startsWith(`${deferredRoot}/`)
  }

  export function sessionOwner(relative: string) {
    const segments = relative.split("/")
    if (segments[0] !== deferredRoot || segments.length < 3) return
    return { scopeID: segments[1], sessionID: segments[2] }
  }

  export function locatorKey(sessionID: string) {
    return [...locatorRoot, sessionID]
  }

  export function fileCheckpointKey(sessionID: string, relative: string) {
    return [...fileCheckpointRoot(sessionID), relative]
  }

  export async function readLocator(store: TransactionalStore, sessionID: string): Promise<Locator | undefined> {
    const [locator] = await store.readMany<Locator>([locatorKey(sessionID)])
    return locator
  }

  export interface Catalog extends Locator {
    info?: unknown
  }
  export interface Info {
    boundary: string
    backupID?: string
    discovered?: boolean
    counts: { pending: number; partial: number; imported: number; quarantined: number; total: number }
  }

  export const infoKey = ["compat_import", "info"]
  export const catalogKey = (locator: Locator) => [
    "compat_catalog",
    locator.scopeID,
    String(locator.activity ?? 0).padStart(16, "0"),
    locator.sessionID,
  ]

  export async function setLocator(tx: StoreTransaction, locator: Locator, info?: unknown) {
    const [previous, catalog, state] = await tx.readMany<Locator | Catalog | Info>([
      locatorKey(locator.sessionID),
      catalogKey(locator),
      infoKey,
    ])
    const before = previous as Locator | undefined
    const current = state as Info | undefined
    const counts = { ...(current?.counts ?? { pending: 0, partial: 0, imported: 0, quarantined: 0, total: 0 }) }
    if (!before) {
      counts.total++
      counts[locator.status]++
    } else if (before.status !== locator.status) {
      counts[before.status]--
      counts[locator.status]++
    }
    await tx.writeMany([
      { key: locatorKey(locator.sessionID), value: locator },
      { key: infoKey, value: { ...current, boundary, counts } },
    ])
    if (locator.status === "imported") await tx.remove(["compat_pending", locator.sessionID])
    else await tx.write(["compat_pending", locator.sessionID], { scopeID: locator.scopeID })
    if (locator.status === "imported") await tx.remove(catalogKey(locator))
    else await tx.write(catalogKey(locator), { ...locator, info: info ?? (catalog as Catalog | undefined)?.info })
  }

  export function writeLocator(store: TransactionalStore, locator: Locator) {
    return store.transaction((tx) => setLocator(tx, locator))
  }

  export async function* catalog(store: TransactionalStore, scopeID?: string) {
    let after: string[] | undefined
    for (;;) {
      const page = await store.query<Catalog>({ kind: "compat_catalog", scopeID, after, limit: 128, descending: true })
      yield* page.map((row) => row.value)
      if (page.length < 128) return
      after = page.at(-1)!.key
    }
  }

  export async function pendingLocators(store: TransactionalStore): Promise<Locator[]> {
    const result: Locator[] = []
    for await (const entry of catalog(store))
      if (entry.status === "pending" || entry.status === "partial") result.push(entry)
    return result
  }

  export async function assertConverged(store: TransactionalStore) {
    const locators = await store.readMany<Locator>(await store.list(locatorRoot))
    if (locators.some((entry) => entry && entry.status !== "imported"))
      throw new StorageIntegrityError(
        "Deferred legacy sessions must finish importing or be repaired before transferring storage",
      )
  }

  /**
   * Seeds one locator per session aggregate directory before activation
   * retires anything. Stat-only on purpose: hashing every pending rollout blob
   * here would re-create the startup cost the deferral exists to remove.
   */
  export async function seedLocators(store: TransactionalStore, dataRoot: string, backupID?: string) {
    const [previous] = await store.readMany<Info>([infoKey])
    if (previous?.discovered) return 0
    const counts = previous?.counts ?? { pending: 0, partial: 0, imported: 0, quarantined: 0, total: 0 }
    if (!previous?.counts) {
      for (const locator of await store.readMany<Locator>(await store.list(locatorRoot))) {
        if (!locator) continue
        counts[locator.status]++
        counts.total++
      }
    }
    await store.write(infoKey, { ...previous, boundary, backupID: backupID ?? previous?.backupID, counts })
    const sessionsRoot = path.join(dataRoot, deferredRoot)
    const scopes = await fs.readdir(sessionsRoot).catch((error) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      return []
    })
    let seeded = 0
    const seen = new Map<string, string>()
    let batch: Array<{ locator: Locator; info?: unknown }> = []
    const flush = async () => {
      if (!batch.length) return
      const pending = batch
      batch = []
      await store.transaction(async (tx) => {
        for (const { locator, info } of pending) await setLocator(tx, locator, info)
      })
      seeded += pending.length
    }
    for (const scopeID of scopes) {
      const scopeDir = path.join(sessionsRoot, scopeID)
      if (!(await fs.stat(scopeDir).then((entry) => entry.isDirectory()))) continue
      for (const sessionID of await fs.readdir(scopeDir)) {
        if (sessionID === ".locks" || sessionID.startsWith(".tmp-")) continue
        const sessionDir = path.join(scopeDir, sessionID)
        if (!(await fs.stat(sessionDir).then((entry) => entry.isDirectory()))) continue
        const otherScope = seen.get(sessionID)
        if (otherScope && otherScope !== scopeID)
          throw new StorageIntegrityError("Deferred Session identity belongs to more than one Scope")
        seen.set(sessionID, scopeID)
        const existing = await readLocator(store, sessionID)
        if (existing && existing.scopeID !== scopeID)
          throw new StorageIntegrityError("Deferred Session identity belongs to more than one Scope")
        let info: unknown
        try {
          info = JSON.parse(await fs.readFile(path.join(sessionDir, "info.json"), "utf8"))
        } catch (error) {
          if (
            !(error instanceof SyntaxError) &&
            !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          )
            throw error
        }
        const time = info && typeof info === "object" && "time" in info ? info.time : undefined
        const updated = time && typeof time === "object" && "updated" in time ? time.updated : undefined
        const activity = typeof updated === "number" && Number.isSafeInteger(updated) && updated >= 0 ? updated : 0
        batch.push({ locator: existing ?? { sessionID, scopeID, status: "pending", activity }, info })
        if (batch.length >= 256) await flush()
      }
    }
    await flush()
    await store.transaction(async (tx) => {
      const state = await tx.read<Info>(infoKey)
      await tx.write(infoKey, { ...state, discovered: true })
    })
    return seeded
  }

  /**
   * The compat replacement for rejectLegacyWriters. Deferred session JSON is
   * allowed only while its aggregate has not been imported: a JSON file under
   * an imported (or unknown) session, and any surviving record outside the
   * deferred tree, means a legacy writer is alive.
   */
  export async function rejectForeignWriters(dataRoot: string, store: TransactionalStore) {
    const [info] = await store.readMany<Info>([infoKey])
    const locators = new Map(
      (await store.readMany<Locator>(await store.list(locatorRoot))).flatMap((entry) =>
        entry ? [[entry.sessionID, entry] as const] : [],
      ),
    )
    for await (const relative of legacyRecords(dataRoot)) {
      if (info?.backupID || !deferRelative(relative)) {
        throw new StorageIntegrityError(
          `Legacy JSON records appeared after database activation (${relative}); preserve both datasets and resolve the old writer before starting`,
        )
      }
      const owner = sessionOwner(relative)
      if (!owner) continue
      const locator = locators.get(owner.sessionID)
      if (!locator || locator.scopeID !== owner.scopeID || locator.status === "imported")
        throw new StorageIntegrityError(
          `Imported session ${owner.sessionID} has legacy JSON again (${relative}); a legacy writer is still active`,
        )
    }
  }
}
