import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import type { Migration } from "../migration"
import { ConfigSet } from "./set"
import { Filesystem } from "../util/filesystem"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"

const log = Log.create({ service: "config.migration" })

async function findConfigFiles(): Promise<string[]> {
  const files = new Set<string>()
  const workingDirectory = Flag.SYNERGY_CWD || process.cwd()

  files.add(ConfigSet.defaultFilePath())

  const sets = await ConfigSet.list().catch(() => [])
  for (const set of sets) {
    files.add(set.path)
  }

  for (const file of ["synergy.jsonc", "synergy.json"]) {
    const found = await Filesystem.findUp(file, workingDirectory, workingDirectory).catch(() => [])
    for (const resolved of found) {
      files.add(resolved)
    }
  }

  for (const file of ["synergy.jsonc", "synergy.json"]) {
    const found = await Filesystem.findUp(file, Global.Path.home, Global.Path.home).catch(() => [])
    for (const resolved of found) {
      files.add(resolved)
    }
  }

  return [...files]
}

async function migrateFile(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const channel =
    config.channel && typeof config.channel === "object" && !Array.isArray(config.channel)
      ? (config.channel as Record<string, unknown>)
      : undefined
  const legacyHolos =
    channel?.holos && typeof channel.holos === "object" && !Array.isArray(channel.holos)
      ? (channel.holos as Record<string, unknown>)
      : undefined

  if (!legacyHolos) return false
  if (config.holos !== undefined) {
    log.warn("skipping legacy holos config migration because top-level holos already exists", { path: filepath })
    return false
  }

  let text = raw
  text = applyEdits(
    text,
    modify(text, ["holos"], legacyHolos, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )
  text = applyEdits(
    text,
    modify(text, ["channel", "holos"], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )

  const reparsed = parseJsonc(text) as Record<string, unknown>
  const migratedChannel =
    reparsed.channel && typeof reparsed.channel === "object" && !Array.isArray(reparsed.channel)
      ? (reparsed.channel as Record<string, unknown>)
      : undefined
  if (migratedChannel && Object.keys(migratedChannel).length === 0) {
    text = applyEdits(
      text,
      modify(text, ["channel"], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
    )
  }

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, text)
  log.info("migrated legacy channel.holos config", { path: filepath })
  return true
}

export const migrations: Migration[] = [
  {
    id: "20260410-config-holos-top-level",
    description: "Migrate Holos config from channel.holos to top-level holos",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await migrateFile(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
]
