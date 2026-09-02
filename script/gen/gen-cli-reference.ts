#!/usr/bin/env bun

/**
 * Generates docs/reference/cli.md from the static CLI registration in
 * packages/synergy/src/main.ts and the command modules reachable from it.
 * Deterministic; supports --check for freshness.
 */

import path from "node:path"
import { readFile } from "node:fs/promises"
import { findAssign, findBlock, isFresh, REPO_ROOT, stringLiteral, writeGenerated } from "./shared"

const MAIN = path.join(REPO_ROOT, "packages/synergy/src/main.ts")
const CLI_ROOT = path.join(REPO_ROOT, "packages/synergy/src/cli")
const OUT = path.join(REPO_ROOT, "docs/reference/cli.md")
const GENERATOR = "gen-cli-reference.ts"

interface CliCommand {
  /** yargs command path, e.g. "config" or "config import" */
  name: string
  module: string
  describe: string | null
  file: string
}

interface CliOption {
  flag: string
  describe: string | null
  type: string | null
}

async function resolveModuleFile(baseDir: string, specifier: string): Promise<string | null> {
  const base = path.resolve(baseDir, specifier)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    const exists = await readFile(candidate, "utf8")
      .then(() => true)
      .catch(() => false)
    if (exists) return candidate
  }
  return null
}

/** Relative imports reachable from one file, kept inside the CLI tree. */
async function collectSources(startFile: string): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [startFile]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, "utf8").catch(() => "")
    for (const match of source.matchAll(/import[\s\S]*?from\s*"(\.[^"]+)"/g)) {
      const specifier = match[1]!
      if (specifier.includes(".txt") || specifier.includes(".json")) continue
      const resolved = await resolveModuleFile(path.dirname(file), specifier)
      if (resolved && resolved.startsWith(CLI_ROOT) && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return [...seen]
}

interface CommandBlock {
  name: string
  describe: string | null
  options: CliOption[]
}

export function parseCommandBlocks(source: string): CommandBlock[] {
  const blocks: CommandBlock[] = []
  for (const match of source.matchAll(/\bcmd\(\{/g)) {
    const body = findBlock(source.slice(match.index!), "cmd(", "{", "}")
    if (!body) continue
    const name = findAssign(body, "command")
    if (!name || name.includes("$")) continue
    const options: CliOption[] = []
    for (const option of body.matchAll(/\.option\(\s*["']([^"']+)["']\s*,\s*\{([\s\S]*?)\}/g)) {
      options.push({
        flag: option[1]!,
        describe: findAssign(option[2]!, "describe"),
        type: findAssign(option[2]!, "type"),
      })
    }
    blocks.push({ name, describe: findAssign(body, "describe"), options })
  }
  return blocks
}

async function commandRegistrations(): Promise<CliCommand[]> {
  const main = await readFile(MAIN, "utf8")
  const commands: CliCommand[] = []
  for (const match of main.matchAll(/\.command\((\w+)\)/g)) {
    const moduleName = match[1]!
    const importMatch = main.match(new RegExp(`import\\s*\\{\\s*${moduleName}\\s*\\}\\s*from\\s*"([^"]+)"`))
    const modulePath = importMatch ? await resolveModuleFile(path.dirname(MAIN), importMatch[1]!) : null
    commands.push({
      name: moduleName.replace(/Command$/, "").toLowerCase(),
      module: moduleName,
      describe: null,
      file: modulePath ? path.relative(REPO_ROOT, modulePath) : "(unresolved)",
    })
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name))
}

export async function generate(): Promise<string> {
  const topLevel = await commandRegistrations()
  const topNames = new Set(topLevel.map((command) => command.name))

  // Collect every command block reachable from the top-level modules. Blocks
  // are tracked globally (detail sections) and per top-level module (command
  // table): a top-level command and a nested subcommand may share a block
  // name (`export` vs `config export`), so the table resolves through the
  // command's own module while detail sections keep the merged view.
  const blocks = new Map<string, CommandBlock>()
  const blocksByModule = new Map<string, Map<string, CommandBlock>>()
  for (const command of topLevel) {
    if (!command.file || command.file === "(unresolved)") continue
    const own = new Map<string, CommandBlock>()
    const sources = await collectSources(path.join(REPO_ROOT, command.file))
    for (const file of sources) {
      const source = await readFile(file, "utf8").catch(() => "")
      for (const block of parseCommandBlocks(source)) {
        own.set(block.name, block)
        blocks.set(block.name, block)
      }
    }
    blocksByModule.set(command.name, own)
  }

  const rows: string[] = []
  for (const command of topLevel) {
    const block = blocksByModule.get(command.name)?.get(command.name)
    rows.push(`| \`${command.name}\` | ${block?.describe ?? command.describe ?? ""} |`)
  }

  const detail: string[] = []
  for (const [name, block] of [...blocks.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    detail.push(`## ${name}`)
    if (block.describe) detail.push("", block.describe, "")
    if (block.options.length > 0) {
      detail.push("| Option | Description |", "| --- | --- |")
      for (const option of block.options) {
        const type = option.type ? ` (${option.type})` : ""
        const describe = option.describe ?? ""
        detail.push(`| \`--${option.flag}\`${type} | ${describe} |`)
      }
    }
    detail.push("")
  }

  return [
    "# CLI Reference",
    "",
    "Generated from the CLI registration in `packages/synergy/src/main.ts`. Concept and lifecycle guidance lives in [CLI guide](cli-guide.md); use `synergy --help` or `synergy <command> --help` for the exact options of the installed version.",
    "",
    "## Commands",
    "",
    "| Command | Description |",
    "| --- | --- |",
    rows.join("\n"),
    "",
    ...detail,
  ].join("\n")
}

if (import.meta.main) {
  const body = await generate()
  if (process.argv.includes("--check")) {
    if (await isFresh(OUT, GENERATOR, body)) {
      console.log(`${GENERATOR}: fresh`)
      process.exit(0)
    }
    console.error(`${GENERATOR}: docs/reference/cli.md is stale — run bun script/gen/${GENERATOR}`)
    process.exit(1)
  }
  await writeGenerated(OUT, GENERATOR, body)
  console.log("wrote docs/reference/cli.md")
}
