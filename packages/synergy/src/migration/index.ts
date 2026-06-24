import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { MigrationRegistry } from "./registry"
import { orderMigrations } from "./order"
import { progressBar, stageWrite, disableWrap, enableWrap, PROGRESS_INTERVAL } from "./format"
import { Installation } from "../global/installation"
import { setActiveMigrationContext } from "./context"
// Side-effect imports: register domain migrations in MigrationRegistry
import "../agenda/migration"
import "../browser/migration"
import "../config/migration"
import "../engram/migration"
import "../scope/migration"
import "../session/migration"
import "../note/migration"
import "../blueprint/migration"
import "../holos/migration"
import type { Migration, RunOptions, MigrationContext } from "./types"

export type { Migration, RunOptions, RunResult, MigrationContext } from "./types"

const log = Log.create({ service: "migration" })

let runningMigrations: Promise<void> | undefined
let migrationsCompleted = false

function collectByDomain(options?: { targetDomain?: string }): Map<string, Migration[]> {
  const result = new Map<string, Migration[]>()
  for (const [domain, migrations] of MigrationRegistry.list()) {
    if (options?.targetDomain && domain !== options.targetDomain) continue
    result.set(domain, [...migrations])
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

  // Group migration IDs by domain using the registry
  for (const [domain, migrations] of MigrationRegistry.list()) {
    const domainData: Record<string, number> = {}
    for (const m of migrations) {
      if (m.id in oldData) {
        domainData[m.id] = oldData[m.id]
      }
    }
    if (Object.keys(domainData).length > 0) {
      await Storage.write(StoragePath.metaMigrationLogDomain(domain), domainData)
      log.info("migrated tracking data to per-domain log", { domain, count: Object.keys(domainData).length })
    }
  }

  // Delete old log
  await Storage.remove(oldLogKey)
  log.info("removed old migration log")
}

export async function ensureMigrations(): Promise<void> {
  if (migrationsCompleted) return
  runningMigrations ??= runMigrations().finally(() => {
    runningMigrations = undefined
    migrationsCompleted = true
  })
  return runningMigrations
}

export function resetMigrations(): void {
  migrationsCompleted = false
  runningMigrations = undefined
}

export async function runMigrations(options?: RunOptions): Promise<void> {
  await migrateOldTrackingData()

  const dryRun = options?.dryRun ?? false
  const domains = collectByDomain({ targetDomain: options?.targetDomain })
  if (domains.size === 0) return

  // Set up context for migrations that want it (arity-based detection)
  const ctx: MigrationContext = {
    log: (msg: string) => log.info(msg),
    appVersion: Installation.VERSION,
    dryRun,
  }
  setActiveMigrationContext(ctx)
  try {
    await runMigrationsInternal(domains, { dryRun, ctx })
  } finally {
    setActiveMigrationContext(undefined)
  }
}

async function runMigrationsInternal(
  domains: Map<string, Migration[]>,
  options: { dryRun: boolean; ctx: MigrationContext },
): Promise<void> {
  const { dryRun, ctx } = options

  const domainNames = [...domains.keys()].sort()
  disableWrap()
  stageWrite("\n")

  const upToDateDomains: string[] = []

  try {
    for (const domain of domainNames) {
      const migrations = orderMigrations(domains.get(domain)!)
      const logData = await loadLogForDomain(domain)
      const pending = migrations.filter((m) => !(m.id in logData))

      if (pending.length === 0) {
        upToDateDomains.push(domain)
        continue
      }

      for (const migration of pending) {
        if (dryRun) {
          stageWrite(`  [DRY-RUN] [${domain}] ${migration.description}\n`)
          continue
        }

        try {
          let lastProgressTime = 0
          let started = false
          // Arity detection: existing migrations have up(progress) with 1 param;
          // new migrations may have up(context, progress) with 2 params.
          const upFn = migration.up
          const progressCb = (current: number, total: number) => {
            if (!started) started = true
            const now = Date.now()
            if (now - lastProgressTime < PROGRESS_INTERVAL && current < total) return
            lastProgressTime = now
            stageWrite(
              `  ${progressBar(current / total)} [${domain}] ${migration.description} (${current}/${total})`,
              true,
            )
          }

          if (upFn.length === 1) {
            await upFn(progressCb)
          } else {
            // Two-param up with context: up(ctx, progress)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (upFn as any)(ctx, progressCb)
          }

          if (!started) stageWrite(`  ${progressBar(0)} [${domain}] ${migration.description}`, true)
          stageWrite(`  ${progressBar(1)} [${domain}] ${migration.description} ✓\n`, true)
          logData[migration.id] = Date.now()
          await saveLogForDomain(domain, logData)
          log.info("completed", { id: migration.id, domain })
        } catch (err) {
          stageWrite(`  ${progressBar(0)} [${domain}] ${migration.description} ✗\n`, true)
          log.error("failed", { id: migration.id, domain, error: err instanceof Error ? err : new Error(String(err)) })
          throw err
        }
      }
    }

    // Summary: print "up to date" status once for all domains, not per domain
    if (upToDateDomains.length > 0) {
      stageWrite(
        `  ${progressBar(1)} ${upToDateDomains.length} domain${upToDateDomains.length === 1 ? "" : "s"} up to date\n`,
      )
    }
  } finally {
    enableWrap()
  }
}

async function loadLogForDomain(domain: string): Promise<Record<string, number>> {
  return Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain(domain)).catch(() => ({}))
}

async function saveLogForDomain(domain: string, data: Record<string, number>): Promise<void> {
  await Storage.write(StoragePath.metaMigrationLogDomain(domain), data)
}

/**
 * Rollback migrations up to (and including) the specified migration ID.
 * Runs `down()` in reverse order for all completed migrations from the
 * target back to the earliest in the domain.
 */
export async function rollbackMigrations(domain: string, targetId: string): Promise<void> {
  const domainMigrations = MigrationRegistry.list().get(domain)
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
        delete logData[migration.id]
        await saveLogForDomain(domain, logData)
        continue
      }

      try {
        await migration.down(() => {})
        stageWrite(`  [${domain}] ${migration.description} rolled back ✓\n`)
        delete logData[migration.id]
        await saveLogForDomain(domain, logData)
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
