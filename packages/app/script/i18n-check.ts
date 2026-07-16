#!/usr/bin/env bun

import { readdir } from "node:fs/promises"
import path from "node:path"

const appDir = path.resolve(import.meta.dir, "..")
const repositoryRoot = path.resolve(appDir, "../..")
const catalogsRoot = path.join(appDir, "src/locales")

export function changedCatalogPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((file) => before.get(file) !== after.get(file)).toSorted()
}

function decodePoString(value: string): string {
  return JSON.parse(`"${value}"`) as string
}

function catalogTranslations(catalog: string): Map<string, string> {
  const translations = new Map<string, string>()
  const entries = /^msgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"$/gm

  for (const match of catalog.matchAll(entries)) {
    const id = decodePoString(match[1] ?? "")
    if (!id) continue
    translations.set(id, decodePoString(match[2] ?? ""))
  }

  return translations
}

export function missingTranslationIds(source: string, target: string): string[] {
  const sourceMessages = catalogTranslations(source)
  const targetMessages = catalogTranslations(target)
  return [...sourceMessages.keys()].filter((id) => !targetMessages.get(id)?.trim())
}

async function readCatalogs(root: string): Promise<Map<string, string>> {
  const catalogs = new Map<string, string>()

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      if (!entry.name.endsWith(".po")) continue
      catalogs.set(path.relative(root, file), await Bun.file(file).text())
    }
  }

  await visit(root)
  return catalogs
}

async function run(command: string[], cwd: string): Promise<boolean> {
  const process = Bun.spawn(command, {
    cwd,
    env: processEnv(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return (await process.exited) === 0
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" }
}

async function main(): Promise<void> {
  const before = await readCatalogs(catalogsRoot)
  const extracted = await run([process.execPath, "run", "script/i18n-extract.ts"], appDir)
  const after = await readCatalogs(catalogsRoot)
  const changed = changedCatalogPaths(before, after)

  if (changed.length > 0) {
    console.error("Localization catalogs changed after extraction:")
    for (const file of changed) console.error(`  src/locales/${file}`)
    console.error("Run `bun run --cwd packages/app i18n:extract`, translate new messages, and commit the catalogs.")
  }

  const sourceCatalog = after.get("en/messages.po")
  const chineseCatalog = after.get("zh-CN/messages.po")
  const missingChineseTranslations =
    sourceCatalog && chineseCatalog ? missingTranslationIds(sourceCatalog, chineseCatalog) : ["<missing-catalog>"]

  if (missingChineseTranslations.length > 0) {
    console.error(`Simplified Chinese catalog has ${missingChineseTranslations.length} missing translation(s):`)
    for (const id of missingChineseTranslations.slice(0, 20)) console.error(`  ${id}`)
    if (missingChineseTranslations.length > 20) {
      console.error(`  ...and ${missingChineseTranslations.length - 20} more`)
    }
  }

  const compiled = await run([process.execPath, "run", "i18n:compile", "--", "--strict"], appDir)
  const sourceContract = await run([process.execPath, "run", "localization:source"], repositoryRoot)

  if (!extracted || changed.length > 0 || missingChineseTranslations.length > 0 || !compiled || !sourceContract) {
    process.exit(1)
  }
}

if (import.meta.filename === process.argv[1]) await main()
