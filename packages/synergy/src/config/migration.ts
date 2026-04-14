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

function normalizeLegacyHolosConfig(input: Record<string, unknown>) {
  const accounts =
    input.accounts && typeof input.accounts === "object" && !Array.isArray(input.accounts)
      ? (input.accounts as Record<string, unknown>)
      : undefined
  const defaultAccount =
    accounts?.default && typeof accounts.default === "object" && !Array.isArray(accounts.default)
      ? (accounts.default as Record<string, unknown>)
      : undefined

  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : typeof defaultAccount?.enabled === "boolean"
          ? defaultAccount.enabled
          : true,
    apiUrl: typeof input.apiUrl === "string" ? input.apiUrl : "https://api.holosai.io",
    wsUrl: typeof input.wsUrl === "string" ? input.wsUrl : "wss://api.holosai.io",
    portalUrl: typeof input.portalUrl === "string" ? input.portalUrl : "https://www.holosai.io",
  }
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

  let text = raw
  const hasTopLevelHolos = config.holos !== undefined

  if (!hasTopLevelHolos) {
    text = applyEdits(
      text,
      modify(text, ["holos"], normalizeLegacyHolosConfig(legacyHolos), {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      }),
    )
  }

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
  log.info(hasTopLevelHolos ? "removed legacy channel.holos config" : "migrated legacy channel.holos config", {
    path: filepath,
  })
  return true
}

async function migrateSchemaUrl(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const schema = config.$schema
  if (typeof schema !== "string" || !schema.startsWith("https://")) return false

  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
  const text = applyEdits(raw, modify(raw, ["$schema"], Global.Path.configSchemaUrl, { formattingOptions }))

  await Bun.write(filepath, text)
  log.info("migrated $schema from remote URL to local file:// path", {
    path: filepath,
    from: schema,
    to: Global.Path.configSchemaUrl,
  })
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
  {
    id: "20260413-config-holos-legacy-cleanup",
    description: "Remove legacy channel.holos config when top-level holos already exists",
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
  {
    id: "20260414-config-schema-local",
    description: "Migrate $schema from remote URL to local file:// path",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await migrateSchemaUrl(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
]
