import path from "path"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { MigrationRegistry } from "./registry"
import { orderMigrations } from "./order"
import { progressBar, stageWrite, disableWrap, enableWrap, PROGRESS_INTERVAL } from "./format"
import { Global } from "../global"
import { Installation } from "../global/installation"
import { setActiveMigrationContext } from "./context"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
// Side-effect imports: register harness-core domain migrations in
// MigrationRegistry. Product-domain migrations register through the L4
// product manifest (src/product-registration.ts) loaded by real entry points.
import "../config/migration"
import "../scope/migration"
import "../session/migration"
import "../observability/migration"
import type { Migration, RunOptions, MigrationContext, MigrationSummary } from "./types"

export type { Migration, RunOptions, RunResult, MigrationContext, MigrationSummary, MigrationReporter } from "./types"

const log = Log.create({ service: "migration" })

let runningMigrations: Promise<MigrationSummary> | undefined
let migrationsCompleted = false
let lastSummary: MigrationSummary | undefined

function collectByDomain(options?: { targetDomain?: string }): Map<string, Migration[]> {
  const result = new Map<string, Migration[]>()
  for (const [owner, migrations] of MigrationRegistry.list()) {
    if (!migrations.length && (!options?.targetDomain || options.targetDomain === owner)) result.set(owner, [])
    for (const migration of migrations) {
      const domain = migration.domain ?? owner
      if (options?.targetDomain && domain !== options.targetDomain) continue
      const group = result.get(domain) ?? []
      if (group.some((entry) => entry.id === migration.id))
        throw new Error(`Duplicate migration ${domain}/${migration.id}`)
      group.push(migration)
      result.set(domain, group)
    }
  }
  return result
}

/**
 * Migrate old single log file (`meta/migration/log.json`) to per-domain log files.
 * Idempotent — safe to run multiple times.
 */
async function migrateOldTrackingData(): Promise<void> {
  const oldLogKey = StoragePath.metaMigrationLog()
  const oldData = await Storage.read<Record<string, number>>(oldLogKey).catch(() => null)
  if (!oldData) return
  const remaining = { ...oldData }

  // Group migration IDs by domain using the registry
  for (const [domain, migrations] of collectByDomain()) {
    const domainData: Record<string, number> = {}
    for (const m of migrations) {
      if (m.id in oldData) {
        domainData[m.id] = oldData[m.id]
        delete remaining[m.id]
        continue
      }
      const legacyId: string | undefined = MigrationRegistry.legacyTracking()
        .filter((owner) => owner.targetDomain === domain)
        .flatMap((owner) => Object.entries(owner.aliases))
        .find(([legacy, modern]) => modern === m.id && legacy in oldData)?.[0]
      if (legacyId && legacyId in oldData) {
        domainData[m.id] = oldData[legacyId]
        delete remaining[legacyId]
      }
    }
    if (Object.keys(domainData).length > 0) {
      await mergeDomainLog(domain, domainData)
      log.info("migrated tracking data to per-domain log", { domain, count: Object.keys(domainData).length })
    }
  }

  // Unregistered domains may be installed later and still need their history.
  if (Object.keys(remaining).length > 0) {
    if (Object.keys(remaining).length !== Object.keys(oldData).length) await Storage.write(oldLogKey, remaining)
    return
  }
  await Storage.remove(oldLogKey)
  log.info("removed old migration log")
}

async function migrateRegisteredLegacyTrackingData(): Promise<void> {
  for (const owner of MigrationRegistry.legacyTracking()) {
    const oldKey = StoragePath.metaMigrationLogDomain(owner.sourceDomain)
    const oldData = await Storage.read<Record<string, number>>(oldKey).catch(() => null)
    if (!oldData) continue
    const migrated = Object.fromEntries(
      Object.entries(oldData).map(([id, timestamp]) => [owner.aliases[id] ?? owner.rename?.(id) ?? id, timestamp]),
    )
    const current = await loadLogForDomain(owner.targetDomain)
    await mergeDomainLog(owner.targetDomain, { ...migrated, ...current })
    await Storage.remove(oldKey)
  }
}

export async function ensureMigrations(options?: RunOptions): Promise<MigrationSummary> {
  if (migrationsCompleted) {
    const summary = lastSummary ?? emptySummary()
    options?.reporter?.summary(summary)
    return summary
  }
  runningMigrations ??= runMigrations({ ...options, output: options?.output ?? "silent" })
    .then((summary) => {
      migrationsCompleted = true
      lastSummary = summary
      return summary
    })
    .finally(() => {
      runningMigrations = undefined
    })
  return runningMigrations
}

export function resetMigrations(): void {
  migrationsCompleted = false
  runningMigrations = undefined
  lastSummary = undefined
}

export async function runMigrations(options?: RunOptions): Promise<MigrationSummary> {
  await migrateOldTrackingData()
  await migrateRegisteredLegacyTrackingData()

  const dryRun = options?.dryRun ?? false
  const output = options?.output ?? "interactive"
  const domains = collectByDomain({ targetDomain: options?.targetDomain })
  if (domains.size === 0) return emptySummary()

  // Set up context for migrations that want it (arity-based detection)
  const ctx: MigrationContext = {
    log: (msg: string) => log.info(msg),
    appVersion: Installation.VERSION,
    dryRun,
  }
  setActiveMigrationContext(ctx)
  try {
    return await runMigrationsInternal(domains, { dryRun, ctx, output, reporter: options?.reporter })
  } finally {
    setActiveMigrationContext(undefined)
  }
}

async function runMigrationsInternal(
  domains: Map<string, Migration[]>,
  options: {
    dryRun: boolean
    ctx: MigrationContext
    output: NonNullable<RunOptions["output"]>
    reporter?: RunOptions["reporter"]
  },
): Promise<MigrationSummary> {
  const { dryRun, ctx, output, reporter } = options

  const domainNames = [...domains.keys()].sort()
  if (output === "interactive") {
    disableWrap()
    stageWrite("\n")
  }

  const upToDateDomains: string[] = []
  const summary = emptySummary()
  summary.totalDomains = domainNames.length

  try {
    for (const domain of domainNames) {
      const migrations = orderMigrations(domains.get(domain)!)
      const logData = await loadLogForDomain(domain)
      const pending = migrations.filter((m) => !(m.id in logData))

      if (pending.length === 0) {
        upToDateDomains.push(domain)
        summary.upToDateDomains++
        continue
      }

      for (const migration of pending) {
        if (dryRun) {
          summary.dryRun++
          if (output === "interactive") {
            stageWrite(`  [DRY-RUN] [${domain}] ${migration.description}\n`)
          }
          continue
        }

        try {
          reporter?.started?.({ domain, migration })
          if (output === "interactive") {
            stageWrite(`  ${progressBar(0)} Starting [${domain}] ${migration.description}`, true)
          }
          let lastProgressTime = 0
          let currentPhase = 0
          // Arity detection: existing migrations have up(progress) with 1 param;
          // new migrations may have up(context, progress) with 2 params.
          const upFn = migration.up
          const progressCb = (current: number, total: number, phase = 0) => {
            if (!Number.isSafeInteger(phase) || phase < currentPhase) return
            if (phase > currentPhase) {
              currentPhase = phase
              lastProgressTime = -Infinity
              reporter?.started?.({ domain, migration })
            }
            const now = Date.now()
            if (now - lastProgressTime < PROGRESS_INTERVAL && current < total) return
            lastProgressTime = now
            reporter?.progress?.({ domain, migration, current, total, dryRun })
            if (output === "interactive") {
              const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0
              const counts = total > 0 ? `${Math.floor(ratio * 100)}% (${current}/${total})` : "Preparing"
              stageWrite(`  ${progressBar(ratio)} ${counts} [${domain}] ${migration.description}`, true)
            }
          }

          if (upFn.length === 1) {
            await upFn(progressCb)
          } else {
            // Two-param up with context: up(ctx, progress)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (upFn as any)(ctx, progressCb)
          }

          if (output === "interactive") {
            stageWrite(`  ${progressBar(1)} [${domain}] ${migration.description} ✓\n`, true)
          }
          logData[migration.id] = Date.now()
          await saveLogForDomain(domain, logData)
          summary.completed++
          log.info("completed", { id: migration.id, domain })
        } catch (err) {
          summary.failed++
          if (output === "interactive") {
            stageWrite(`  ✗ [${domain}] ${migration.description}\n`, true)
          }
          log.error("failed", { id: migration.id, domain, error: err instanceof Error ? err : new Error(String(err)) })
          throw err
        }
      }
    }

    // Summary: print "up to date" status once for all domains, not per domain
    if (output !== "silent" && upToDateDomains.length > 0) {
      stageWrite(
        `  ${progressBar(1)} ${upToDateDomains.length} domain${upToDateDomains.length === 1 ? "" : "s"} up to date\n`,
      )
    }
    reporter?.summary(summary)
    return summary
  } finally {
    if (output === "interactive") enableWrap()
  }
}

function emptySummary(): MigrationSummary {
  return {
    totalDomains: 0,
    upToDateDomains: 0,
    completed: 0,
    dryRun: 0,
    failed: 0,
  }
}

async function loadLogForDomain(domain: string): Promise<Record<string, number>> {
  return Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain(domain)).catch(() => ({}))
}

function migrationLockDirectory() {
  return path.join(Global.Path.data, "meta", "migration", ".locks")
}

function migrationLockOptions(domain: string) {
  return {
    directory: migrationLockDirectory(),
    key: `migration-log:${domain}`,
    timeoutMessage: `Timed out acquiring migration tracking lock for ${domain}`,
  }
}

/**
 * Merge completion markers into the per-domain migration log under a cross-process
 * file lock. Multiple Synergy instances sharing one home may run migrations
 * concurrently; a plain read-modify-write would let the last writer drop markers
 * persisted by the other process, re-pending completed migrations on the next boot.
 */
async function mergeDomainLog(domain: string, entries: Record<string, number>): Promise<void> {
  const key = StoragePath.metaMigrationLogDomain(domain)
  await withFileLock(migrationLockOptions(domain), async () => {
    const current = await Storage.read<Record<string, number>>(key).catch(() => ({}))
    await Storage.write(key, { ...current, ...entries })
  })
}

async function saveLogForDomain(domain: string, data: Record<string, number>): Promise<void> {
  await mergeDomainLog(domain, data)
}

/** Remove a single completion marker under the same cross-process lock, preserving concurrent markers. */
async function deleteDomainLogEntry(domain: string, migrationID: string): Promise<void> {
  const key = StoragePath.metaMigrationLogDomain(domain)
  await withFileLock(migrationLockOptions(domain), async () => {
    const current: Record<string, number> = await Storage.read<Record<string, number>>(key).catch(() => ({}))
    delete current[migrationID]
    await Storage.write(key, current)
  })
}

/**
 * Rollback migrations up to (and including) the specified migration ID.
 * Runs `down()` in reverse order for all completed migrations from the
 * target back to the earliest in the domain.
 */
export async function rollbackMigrations(domain: string, targetId: string): Promise<void> {
  const domainMigrations = collectByDomain().get(domain)
  if (!domainMigrations || domainMigrations.length === 0) return

  const ordered = orderMigrations(domainMigrations)
  const logData = await loadLogForDomain(domain)

  // Find completed migrations to roll back: everything from target backwards that's completed
  const toRollback: Migration[] = []
  let foundTarget = false
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i]
    if (m.id === targetId) {
      foundTarget = true
    }
    if (foundTarget && m.id in logData) {
      toRollback.push(m)
    }
    if (foundTarget && !(m.id in logData)) {
      break
    }
  }

  if (!foundTarget) {
    throw new Error(`Migration "${targetId}" not found in domain "${domain}"`)
  }

  if (toRollback.length === 0) {
    stageWrite(`  No completed migrations to roll back in domain "${domain}"\n`)
    return
  }

  disableWrap()
  stageWrite("\n")

  try {
    for (const migration of toRollback) {
      if (!migration.down) {
        stageWrite(`  [${domain}] ${migration.description} (no down(), unmarked)\n`)
        await deleteDomainLogEntry(domain, migration.id)
        continue
      }

      try {
        await migration.down(() => {})
        stageWrite(`  [${domain}] ${migration.description} rolled back ✓\n`)
        await deleteDomainLogEntry(domain, migration.id)
        log.info("rolled back", { id: migration.id, domain })
      } catch (err) {
        stageWrite(`  [${domain}] ${migration.description} rollback ✗\n`)
        log.error("rollback failed", {
          id: migration.id,
          domain,
          error: err instanceof Error ? err : new Error(String(err)),
        })
        throw err
      }
    }
  } finally {
    enableWrap()
  }
}

/**
 * Get migration status for a domain or all domains.
 */
export async function getMigrationStatus(
  domain?: string,
): Promise<Record<string, { completed: Migration[]; pending: Migration[] }>> {
  await migrateOldTrackingData()

  const domains = collectByDomain({ targetDomain: domain })
  const result: Record<string, { completed: Migration[]; pending: Migration[] }> = {}

  for (const [d, migrations] of domains) {
    const ordered = orderMigrations(migrations)
    const logData = await loadLogForDomain(d)
    const completed = ordered.filter((m) => m.id in logData)
    const pending = ordered.filter((m) => !(m.id in logData))
    result[d] = { completed, pending }
  }

  return result
}
