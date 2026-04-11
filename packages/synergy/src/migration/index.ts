import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { migrations as agenda } from "../agenda/migration"
import { migrations as config } from "../config/migration"
import { migrations as engram } from "../engram/migration"
import { migrations as session } from "../session/migration"
import { UI } from "../cli/ui"

export interface Migration {
  id: string
  description: string
  up(progress: (current: number, total: number) => void): Promise<void>
}

const log = Log.create({ service: "migration" })

const BAR_WIDTH = 20

function collect(): Migration[] {
  return [...agenda, ...config, ...engram, ...session]
}

function bar(ratio: number) {
  return UI.progressBar({ ratio, width: BAR_WIDTH })
}

function write(line: string, overwrite = false) {
  process.stderr.write((overwrite ? "\r" : "") + line)
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
    write(`  ${bar(0)} ${migration.description}`)
    try {
      await migration.up((current, total) => {
        write(`  ${bar(current / total)} ${migration.description} (${current}/${total})`, true)
      })
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
