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
import "../library/migration"
import "../scope/migration"
import "../session/migration"
import "../note/migration"
import "../observability/migration"
import "../blueprint/migration"
import "../holos/migration"
import type { Migration, RunOptions, MigrationContext, MigrationSummary } from "./types"

export type { Migration, RunOptions, RunResult, MigrationContext, MigrationSummary, MigrationReporter } from "./types"

const log = Log.create({ service: "migration" })

const LEGACY_LIBRARY_MIGRATION_IDS: Record<string, string> = {
  "20260324-engram-experience-source-model": "20260324-library-experience-source-model",
  "20260405-engram-memory-recall-mode": "20260405-library-memory-recall-mode",
  "20260415-engram-purge-invalid-experiences": "20260415-library-purge-invalid-experiences",
  "20260423-engram-purge-tool-hallucination-intents": "20260423-library-purge-tool-hallucination-intents",
  "20260424-engram-q-updated-at-integer": "20260424-library-q-updated-at-integer",
  "20260425-engram-purge-oversized-tool-log-intents": "20260425-library-purge-oversized-tool-log-intents",
  "20260425b-engram-purge-assistant-reasoning-intents": "20260425b-library-purge-assistant-reasoning-intents",
}

const MODERN_LIBRARY_MIGRATION_IDS = new Map(
  Object.entries(LEGACY_LIBRARY_MIGRATION_IDS).map(([legacy, modern]) => [modern, legacy]),
)

let runningMigrations: Promise<MigrationSummary> | undefined
let migrationsCompleted = false
let lastSummary: MigrationSummary | undefined

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
        continue
      }
      const legacyId = MODERN_LIBRARY_MIGRATION_IDS.get(m.id)
      if (legacyId && legacyId in oldData) {
        domainData[m.id] = oldData[legacyId]
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

async function migrateLegacyLibraryTrackingData(): Promise<void> {
  const oldKey = StoragePath.metaMigrationLogDomain("engram")
  const oldData = await Storage.read<Record<string, number>>(oldKey).catch(() => null)
  if (!oldData) return

  const libraryKey = StoragePath.metaMigrationLogDomain("library")
  const libraryData: Record<string, number> = await Storage.read<Record<string, number>>(libraryKey).catch(() => ({}))
  let changed = false

  for (const [id, timestamp] of Object.entries(oldData)) {
    const modernId = LEGACY_LIBRARY_MIGRATION_IDS[id] ?? id.replace("-engram-", "-library-")
    if (libraryData[modernId] !== undefined) continue
    libraryData[modernId] = timestamp
    changed = true
  }

  if (changed) {
    await Storage.write(libraryKey, libraryData)
    log.info("migrated legacy engram migration tracking to library", { count: Object.keys(oldData).length })
  }
  await Storage.remove(oldKey)
}

export async function ensureMigrations(options?: RunOptions): Promise<MigrationSummary> {
  if (migrationsCompleted) {
    const summary = lastSummary ?? emptySummary()
    options?.reporter?.summary(summary)
    return summary
  }
  runningMigrations ??= runMigrations({ ...options, output: options?.output ?? "silent" }).finally(() => {
    runningMigrations = undefined
    migrationsCompleted = true
  })
  const summary = await runningMigrations
  lastSummary = summary
  return summary
}

export function resetMigrations(): void {
  migrationsCompleted = false
  runningMigrations = undefined
  lastSummary = undefined
}

export async function runMigrations(options?: RunOptions): Promise<MigrationSummary> {
  await migrateOldTrackingData()
  await migrateLegacyLibraryTrackingData()

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
            reporter?.progress?.({ domain, migration, current, total, dryRun })
            if (output === "interactive") {
              stageWrite(
                `  ${progressBar(current / total)} [${domain}] ${migration.description} (${current}/${total})`,
                true,
              )
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
            if (!started) stageWrite(`  ${progressBar(0)} [${domain}] ${migration.description}`, true)
            stageWrite(`  ${progressBar(1)} [${domain}] ${migration.description} ✓\n`, true)
          }
          logData[migration.id] = Date.now()
          await saveLogForDomain(domain, logData)
          summary.completed++
          log.info("completed", { id: migration.id, domain })
        } catch (err) {
          summary.failed++
          if (output === "interactive") {
            stageWrite(`  ${progressBar(0)} [${domain}] ${migration.description} ✗\n`, true)
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
