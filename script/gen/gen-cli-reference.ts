#!/usr/bin/env bun
import ts from "@typescript/typescript6"

/**
 * Generates docs/reference/cli.md from the static CLI registration in
 * the core and product command catalogs and their explicit lazy contributions.
 * Deterministic; supports --check for freshness.
 */

import path from "node:path"
import { readFile } from "node:fs/promises"
import { findAssign, findBlock, isFresh, REPO_ROOT, writeGenerated, resolveWorkspaceModule } from "./shared"
import { FULL_COMPONENTS } from "../../packages/plugin-host/src/installation/catalog"

const MAIN = path.join(REPO_ROOT, "packages/cli/src/cli/commands.ts")
const RUNTIME_COMMANDS = path.join(REPO_ROOT, "packages/cli/src/cli/runtime-commands.ts")
const OUT = path.join(REPO_ROOT, "docs/reference/cli.md")
const GENERATOR = "gen-cli-reference.ts"

interface CliCommand {
  /** yargs command path, e.g. "config" or "config import" */
  name: string
  module: string
  describe: string | null
  file: string
  sources: string[]
  contributions?: Array<{ file: string; member?: string; suffix?: string }>
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
      if (resolved && /\/(?:cli|daemon|commands)\//.test(resolved) && !seen.has(resolved)) queue.push(resolved)
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
  const adapters: string[] = []
  for (const owner of FULL_COMPONENTS) {
    const filename = path.join(REPO_ROOT, "packages", owner, "src/cli-adapter.ts")
    if (await Bun.file(filename).exists()) adapters.push(filename)
  }
  for (const registry of [MAIN, RUNTIME_COMMANDS, ...adapters]) {
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
  for (const adapter of adapters) {
    const source = ts.createSourceFile(adapter, await readFile(adapter, "utf8"), ts.ScriptTarget.Latest, true)
    const contributions: Array<{ group: string; specifier: string; member?: string; suffix?: string }> = []
    function findContributions(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const group = { dataCommands: "data", debugCommands: "debug", pluginCommands: "plugin" }[node.name.text]
        if (group) {
          const selectedGroup = group
          const start = contributions.length
          const suffixes = new Set<string>()
          function findMember(child: ts.Node) {
            if (ts.isPropertyAccessExpression(child)) {
              let target: ts.Expression = child.expression
              while (ts.isParenthesizedExpression(target) || ts.isAwaitExpression(target) || ts.isAsExpression(target))
                target = target.expression
              if (
                ts.isCallExpression(target) &&
                target.expression.kind === ts.SyntaxKind.ImportKeyword &&
                target.arguments[0] &&
                ts.isStringLiteralLike(target.arguments[0])
              )
                contributions.push({
                  group: selectedGroup,
                  specifier: target.arguments[0].text,
                  member: child.name.text,
                })
            }
            if (
              ts.isCallExpression(child) &&
              ts.isPropertyAccessExpression(child.expression) &&
              child.expression.name.text === "endsWith" &&
              child.arguments[0] &&
              ts.isStringLiteralLike(child.arguments[0])
            )
              suffixes.add(child.arguments[0].text)
            ts.forEachChild(child, findMember)
          }
          findMember(node)
          if (contributions.length === start && suffixes.size === 1)
            for (const specifier of moduleSpecifiers(node))
              contributions.push({ group, specifier, suffix: [...suffixes][0] })
        }
      }
      ts.forEachChild(node, findContributions)
    }
    findContributions(source)
    for (const { group, specifier, member, suffix } of contributions) {
      const resolved = await resolveModuleFile(path.dirname(adapter), specifier)
      if (!resolved) throw new Error(`Unresolved ${group} command contribution: ${specifier}`)
      const command = commands.get(group)
      if (command) {
        command.sources.push(resolved)
        ;(command.contributions ??= []).push({ file: resolved, member, suffix })
      }
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

interface CommandDefinition {
  block: CommandBlock
  call: ts.CallExpression
  builder?: ts.Node
}

async function registeredCommandDetails(topLevel: CliCommand[]) {
  const groups = await Promise.all(topLevel.map((command) => collectCommandSources(command.sources)))
  const files = [...new Set(groups.flat())]
  const sources = new Map(
    await Promise.all(
      files.map(
        async (file) =>
          [file, ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true)] as const,
      ),
    ),
  )
  const resolutions = new Map(
    await Promise.all(
      [...sources].map(
        async ([file, source]) =>
          [
            file,
            new Map(
              await Promise.all(
                moduleSpecifiers(source).map(
                  async (specifier) => [specifier, await resolveModuleFile(path.dirname(file), specifier)] as const,
                ),
              ),
            ),
          ] as const,
      ),
    ),
  )
  const options: ts.CompilerOptions = {
    noLib: true,
    noEmit: true,
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (file) => sources.get(file)
  host.fileExists = (file) => sources.has(file)
  host.readFile = (file) => sources.get(file)?.text
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      const file = resolutions.get(containingFile)?.get(name)
      return file && sources.has(file) ? { resolvedFileName: file } : undefined
    })
  const checker = ts.createProgram(files, options, host).getTypeChecker()
  const definitions = new Map<ts.CallExpression, CommandDefinition>()
  for (const source of sources.values()) {
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cmd") {
        const object = node.arguments[0]
        if (object && ts.isObjectLiteralExpression(object)) {
          const block = parseCommandBlocks(`cmd(${object.getText(source)})`)[0]
          const builder = object.properties.find((property) => property.name?.getText(source) === "builder")
          if (block) definitions.set(node, { block, call: node, builder })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  function returned(body: ts.Node) {
    const expressions: ts.Expression[] = []
    function visit(node: ts.Node) {
      if (ts.isReturnStatement(node)) {
        if (node.expression) expressions.push(node.expression)
        return
      }
      if (
        node !== body &&
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
      )
        return
      ts.forEachChild(node, visit)
    }
    visit(body)
    return expressions
  }
  function resolve(expression: ts.Node, seen = new Set<ts.Node>()): CommandDefinition[] {
    if (seen.has(expression)) return []
    const next = new Set(seen).add(expression)
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isAwaitExpression(expression) ||
      ts.isSpreadElement(expression)
    )
      return resolve(expression.expression, next)
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap((entry) => resolve(entry, next))
    if (ts.isConditionalExpression(expression))
      return [...resolve(expression.whenTrue, next), ...resolve(expression.whenFalse, next)]
    if (ts.isCallExpression(expression)) {
      const definition = definitions.get(expression)
      return definition ? [definition] : resolve(expression.expression, next)
    }
    if (ts.isFunctionDeclaration(expression) || ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
      if (!expression.body) return []
      return ts.isBlock(expression.body)
        ? returned(expression.body).flatMap((value) => resolve(value, next))
        : resolve(expression.body, next)
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression)
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
      return declared(symbol, next)
    }
    return []
  }
  function declared(symbol: ts.Symbol | undefined, seen: Set<ts.Node>): CommandDefinition[] {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    return (symbol?.declarations ?? []).flatMap((declaration) => {
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer) return resolve(declaration.initializer, seen)
        const loop = declaration.parent.parent
        if (ts.isForOfStatement(loop) && loop.initializer === declaration.parent) return resolve(loop.expression, seen)
      }
      if (ts.isParameter(declaration) && declaration.initializer) return resolve(declaration.initializer, seen)
      if (ts.isFunctionDeclaration(declaration)) return resolve(declaration, seen)
      return []
    })
  }
  function children(definition: CommandDefinition) {
    const result: CommandDefinition[] = []
    if (!definition.builder) return result
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "command"
      )
        for (const argument of node.arguments) result.push(...resolve(argument))
      ts.forEachChild(node, visit)
    }
    visit(definition.builder)
    return result
  }
  const details = new Map<string, CommandBlock>()
  const roots = new Map<string, CommandBlock>()
  function add(definition: CommandDefinition, name: string, ancestors = new Set<CommandDefinition>()) {
    if (ancestors.has(definition)) throw new Error(`Cyclic CLI registration: ${name}`)
    const previous = details.get(name)
    if (previous && JSON.stringify(previous) !== JSON.stringify(definition.block))
      throw new Error(`Conflicting CLI registration: ${name}`)
    details.set(name, definition.block)
    const prefix = name.split(/\s+[<[]/)[0]!
    for (const child of children(definition))
      add(child, `${prefix} ${child.block.name}`, new Set(ancestors).add(definition))
  }
  for (const command of topLevel) {
    const primary = [...definitions.values()].filter((definition) =>
      command.sources.includes(definition.call.getSourceFile().fileName),
    )
    const root = primary.find((definition) => definition.block.name.split(/\s/)[0] === command.name)
    if (root) {
      roots.set(command.name, root.block)
      add(root, root.block.name)
    } else details.set(command.name, { name: command.name, describe: command.describe, options: [] })
    for (const contribution of command.contributions ?? []) {
      const source = sources.get(contribution.file)
      const symbol = source && checker.getSymbolAtLocation(source)
      const members = symbol
        ? checker
            .getExportsOfModule(symbol)
            .filter((entry) =>
              contribution.member
                ? entry.name === contribution.member
                : contribution.suffix && entry.name.endsWith(contribution.suffix),
            )
        : []
      if (!members.length)
        throw new Error(`Unresolved CLI contribution ${command.name}: ${contribution.member ?? contribution.suffix}`)
      for (const member of members)
        for (const child of declared(member, new Set())) add(child, `${command.name} ${child.block.name}`)
    }
  }
  return { details, roots }
}

export async function generate(): Promise<string> {
  const topLevel = await commandRegistrations()
  const { details: blocks, roots } = await registeredCommandDetails(topLevel)
  const rows = topLevel.map(
    (command) => `| \`${command.name}\` | ${roots.get(command.name)?.describe ?? command.describe ?? ""} |`,
  )

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
