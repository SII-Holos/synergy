import fs from "node:fs/promises"
import path from "node:path"
import { StorageIntegrityError } from "./errors"
import { legacyRecords } from "./legacy-source"
import type { TransactionalStore } from "./transactional-store"

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

  export async function writeLocator(store: TransactionalStore, locator: Locator) {
    await store.write(locatorKey(locator.sessionID), locator)
  }

  export async function pendingLocators(store: TransactionalStore): Promise<Locator[]> {
    const keys = await store.list(locatorRoot)
    const locators = await store.readMany<Locator>(keys)
    return locators
      .filter(
        (entry): entry is Locator => entry !== undefined && (entry.status === "pending" || entry.status === "partial"),
      )
      .sort((a, b) => a.sessionID.localeCompare(b.sessionID))
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
  export async function seedLocators(store: TransactionalStore, dataRoot: string) {
    await store.write(["compat_import", "info"], { boundary })
    const sessionsRoot = path.join(dataRoot, deferredRoot)
    const scopes = await fs.readdir(sessionsRoot).catch((error) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      return []
    })
    let seeded = 0
    let batch: Locator[] = []
    const flush = async () => {
      if (!batch.length) return
      const pending = batch
      batch = []
      await store.transaction(async (tx) => {
        for (const locator of pending) await tx.write(locatorKey(locator.sessionID), locator)
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
        const existing = await readLocator(store, sessionID)
        if (existing && existing.scopeID !== scopeID)
          throw new StorageIntegrityError("Deferred Session identity belongs to more than one Scope")
        if (existing) continue
        batch.push({ sessionID, scopeID, status: "pending" })
        if (batch.length >= 256) await flush()
      }
    }
    await flush()
    return seeded
  }

  /**
   * The compat replacement for rejectLegacyWriters. Deferred session JSON is
   * allowed only while its aggregate has not been imported: a JSON file under
   * an imported (or unknown) session, and any surviving record outside the
   * deferred tree, means a legacy writer is alive.
   */
  export async function rejectForeignWriters(dataRoot: string, store: TransactionalStore) {
    const locators = new Map(
      (await store.readMany<Locator>(await store.list(locatorRoot))).flatMap((entry) =>
        entry ? [[entry.sessionID, entry] as const] : [],
      ),
    )
    for await (const relative of legacyRecords(dataRoot)) {
      if (!deferRelative(relative)) {
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
