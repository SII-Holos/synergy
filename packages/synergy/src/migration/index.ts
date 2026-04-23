import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { migrations as agenda } from "../agenda/migration"
import { migrations as config } from "../config/migration"
import { migrations as engram } from "../engram/migration"
import { migrations as scope } from "../scope/migration"
import { migrations as session } from "../session/migration"
import { UI } from "../cli/ui"

export interface Migration {
  id: string
  description: string
  up(progress: (current: number, total: number) => void): Promise<void>
}

const log = Log.create({ service: "migration" })

const BAR_WIDTH = 20
const PROGRESS_INTERVAL = 200

function collect(): Migration[] {
  return [...agenda, ...config, ...engram, ...scope, ...session]
}

function bar(ratio: number) {
  return UI.progressBar({ ratio, width: BAR_WIDTH })
}

function write(line: string, overwrite = false) {
  // \x1b[2K clears the entire line before \r returns to line start,
  // preventing ghost characters when the new line is shorter.
  process.stderr.write((overwrite ? "\x1b[2K\r" : "") + line)
}

let runningMigrations: Promise<void> | undefined
let migrationsCompleted = false

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

export async function runMigrations(): Promise<void> {
  const all = collect()
  if (all.length === 0) return

  const logData: Record<string, number> = await Storage.read<Record<string, number>>(
    StoragePath.metaMigrationLog(),
  ).catch(() => ({}))
  const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id))
  const pending = sorted.filter((m) => !(m.id in logData))

  if (pending.length === 0) {
    write(`\n  ${bar(1)} Migrations up to date\n`)
    return
  }

  write("\n")

  for (const migration of pending) {
    try {
      let lastProgressTime = 0
      let started = false
      await migration.up((current, total) => {
        if (!started) {
          started = true
        }
        const now = Date.now()
        if (now - lastProgressTime < PROGRESS_INTERVAL && current < total) return
        lastProgressTime = now
        write(`  ${bar(current / total)} ${migration.description} (${current}/${total})`, true)
      })
      if (!started) write(`  ${bar(0)} ${migration.description}`, true)
      write(`  ${bar(1)} ${migration.description} ✓\n`, true)
      logData[migration.id] = Date.now()
      await Storage.write(StoragePath.metaMigrationLog(), logData)
      log.info("completed", { id: migration.id })
    } catch (err) {
      write(`  ${bar(0)} ${migration.description} ✗\n`, true)
      log.error("failed", { id: migration.id, error: err instanceof Error ? err : new Error(String(err)) })
      throw err
    }
  }
}
