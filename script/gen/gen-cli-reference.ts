#!/usr/bin/env bun
import ts from "typescript"

/**
 * Generates docs/reference/cli.md from the static CLI registration in
 * the core and product command catalogs and their explicit lazy contributions.
 * Deterministic; supports --check for freshness.
 */

import path from "node:path"
import { readFile } from "node:fs/promises"
import { findAssign, findBlock, isFresh, REPO_ROOT, writeGenerated, resolveWorkspaceModule } from "./shared"

const MAIN = path.join(REPO_ROOT, "packages/cli/src/cli/commands.ts")
const PRODUCT_COMMANDS = path.join(REPO_ROOT, "packages/product-runtime/src/cli-commands.ts")
const PRODUCT_ENTRY = path.join(REPO_ROOT, "packages/product-runtime/src/index.ts")
const OUT = path.join(REPO_ROOT, "docs/reference/cli.md")
const GENERATOR = "gen-cli-reference.ts"

interface CliCommand {
  /** yargs command path, e.g. "config" or "config import" */
  name: string
  module: string
  describe: string | null
  file: string
  sources: string[]
}

interface CliOption {
  flag: string
  describe: string | null
  type: string | null
}

const resolveModuleFile = resolveWorkspaceModule

function moduleSpecifiers(node: ts.Node): string[] {
  const result = new Set<string>()
  function visit(child: ts.Node) {
    if (
      (ts.isImportDeclaration(child) || ts.isExportDeclaration(child)) &&
      child.moduleSpecifier &&
      ts.isStringLiteralLike(child.moduleSpecifier)
    )
      result.add(child.moduleSpecifier.text)
    if (
      ts.isCallExpression(child) &&
      child.expression.kind === ts.SyntaxKind.ImportKeyword &&
      child.arguments[0] &&
      ts.isStringLiteralLike(child.arguments[0])
    )
      result.add(child.arguments[0].text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return [...result]
}

export async function collectCommandSources(startFiles: string[]): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [...startFiles]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true)
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.includes(".txt") || specifier.includes(".json")) continue
      const resolved = await resolveModuleFile(path.dirname(file), specifier)
      if (resolved && /\/(?:cli|daemon)\//.test(resolved) && !seen.has(resolved)) queue.push(resolved)
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
  const commands = new Map<string, CliCommand>()
  for (const registry of [MAIN, PRODUCT_COMMANDS]) {
    const main = await readFile(registry, "utf8")
    const source = ts.createSourceFile(registry, main, ts.ScriptTarget.Latest, true)
    const entries: Array<{ name: string; describe: string | null; specifiers: string[] }> = []
    function visit(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node)) {
        const properties = new Map(
          node.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [property.name.getText(source), property.initializer]),
        )
        const command = properties.get("command")
        const load = properties.get("load")
        if (command && load) {
          const names = ts.isArrayLiteralExpression(command) ? command.elements : [command]
          const name = names.find((name) => ts.isStringLiteralLike(name) && name.text !== "$0")
          const specifiers = moduleSpecifiers(load)
          const description = properties.get("describe")
          if (name && ts.isStringLiteralLike(name) && specifiers.length)
            entries.push({
              name: name.text.split(" ")[0]!,
              describe: description && ts.isStringLiteralLike(description) ? description.text : null,
              specifiers,
            })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const entry of entries) {
      const sources = await Promise.all(
        entry.specifiers.map(async (specifier) => {
          const resolved = await resolveModuleFile(path.dirname(registry), specifier)
          if (!resolved) throw new Error(`Unresolved CLI contribution ${entry.name}: ${specifier}`)
          return resolved
        }),
      )
      const modulePath = sources[0]!
      commands.set(entry.name, {
        name: entry.name,
        describe: entry.describe,
        module: entry.name,
        file: path.relative(REPO_ROOT, modulePath),
        sources,
      })
    }
  }
  const productEntry = ts.createSourceFile(
    PRODUCT_ENTRY,
    await readFile(PRODUCT_ENTRY, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const dataSpecifiers: string[] = []
  function findDataContribution(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(productEntry) === "dataCommands")
      dataSpecifiers.push(...moduleSpecifiers(node.initializer))
    ts.forEachChild(node, findDataContribution)
  }
  findDataContribution(productEntry)
  for (const specifier of dataSpecifiers) {
    const resolved = await resolveModuleFile(path.dirname(PRODUCT_ENTRY), specifier)
    if (!resolved) throw new Error(`Unresolved data command contribution: ${specifier}`)
    commands.get("data")?.sources.push(resolved)
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function generate(): Promise<string> {
  const topLevel = await commandRegistrations()

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
    const sources = await collectCommandSources(command.sources)
    for (const file of sources) {
      const source = await readFile(file, "utf8").catch(() => "")
      for (const block of parseCommandBlocks(source)) {
        if (!own.has(block.name)) own.set(block.name, block)
        if (!blocks.has(block.name) || file === path.join(REPO_ROOT, command.file)) blocks.set(block.name, block)
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
    "Generated from the core and product CLI catalogs and explicit command contributions. This reference describes the full product; standalone core installations expose the locally composed subset through the same `synergy` command. Concept and lifecycle guidance lives in [CLI guide](cli-guide.md); use `synergy --help` or `synergy <command> --help` for the exact options of the installed version.",
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
