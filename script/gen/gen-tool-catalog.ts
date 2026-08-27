#!/usr/bin/env bun

/**
 * Generates docs/reference/tools.md from the static builtin tool list in
 * packages/synergy/src/tool/registry.ts, each tool module's Tool.define
 * call, and the canonical taxonomy in packages/synergy/src/tool/taxonomy.ts.
 * Deterministic; supports --check for freshness.
 */

import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import {
  findAssign,
  findBlock,
  isFresh,
  mdCell,
  parseObjectFields,
  REPO_ROOT,
  resolveIdentifier,
  stringLiteral,
  writeGenerated,
} from "./shared"

const REGISTRY = path.join(REPO_ROOT, "packages/synergy/src/tool/registry.ts")
const TOOL_DIR = path.join(REPO_ROOT, "packages/synergy/src/tool")
const TAXONOMY = path.join(REPO_ROOT, "packages/synergy/src/tool/taxonomy.ts")
const OUT = path.join(REPO_ROOT, "docs/reference/tools.md")
const GENERATOR = "gen-tool-catalog.ts"

interface ToolEntry {
  id: string
  file: string
  description: string | null
  kind: string
  parameters: Array<{ name: string; type: string | null; description: string | null; optional: boolean }>
}

function builtinNames(registrySource: string): string[] {
  const names: string[] = []
  for (const match of registrySource.matchAll(/\b(\w+Tool)\b/g)) {
    const name = match[1]!
    if (!names.includes(name)) names.push(name)
  }
  return names
}

async function resolveToolFile(
  moduleName: string,
  registrySource: string,
  baseDir: string = TOOL_DIR,
): Promise<string | null> {
  const importMatch = registrySource.match(
    new RegExp(`import\\s*\\{[^}]*\\b${moduleName}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`),
  )
  if (importMatch) {
    const specifier = importMatch[1]!
    const base = specifier.startsWith(".") ? path.resolve(baseDir, specifier) : path.resolve(TOOL_DIR, specifier)
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      const exists = await readFile(candidate, "utf8")
        .then(() => true)
        .catch(() => false)
      if (exists) return candidate
    }
  }
  if (baseDir !== TOOL_DIR) {
    for (const file of await readdir(baseDir, { recursive: true })) {
      const candidate = path.join(baseDir, file)
      if (!candidate.endsWith(".ts")) continue
      const source = await readFile(candidate, "utf8")
      if (source.includes(`export const ${moduleName} =`)) return candidate
    }
    return null
  }
  for (const file of await readdir(TOOL_DIR)) {
    if (!file.endsWith(".ts")) continue
    const source = await readFile(path.join(TOOL_DIR, file), "utf8")
    if (source.includes(`export const ${moduleName} =`)) return path.join(TOOL_DIR, file)
  }
  return null
}

/** Domain register modules (src/&lt;domain&gt;/register.ts) contribute builtin
 * tools through ToolRegistry providers; harvest their names and dirs. */
async function domainRegistries(): Promise<Array<{ source: string; dir: string }>> {
  const srcRoot = path.dirname(TOOL_DIR)
  const out: Array<{ source: string; dir: string }> = []
  for (const entry of await readdir(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of ["register.ts", "tools.ts"]) {
      const registerPath = path.join(srcRoot, entry.name, name)
      const source = await readFile(registerPath, "utf8").catch(() => "")
      if (source) out.push({ source, dir: path.dirname(registerPath) })
    }
  }
  return out
}

/** Resolve a description identifier to its literal or imported .txt content. */
async function resolveDescriptionSource(file: string, source: string, identifier: string): Promise<string | null> {
  const txtImport = source.match(new RegExp(`import\\s+${identifier}\\s+from\\s*"(\\.\\/[^"]+)"`))
  if (txtImport) {
    const specifier = txtImport[1]!
    const txtPath = path.resolve(path.dirname(file), specifier.endsWith(".txt") ? specifier : `${specifier}.txt`)
    return (await readFile(txtPath, "utf8").catch(() => "")).trim() || null
  }
  return resolveIdentifier(source, identifier)
}

async function descriptionOf(file: string, source: string, body: string): Promise<string | null> {
  const direct = findAssign(body, "description")
  if (direct !== null) {
    if (/^\s*$/.test(direct)) return null
    return direct
  }

  // `description: ["a", "b", fn()].join(...)` — extract the literal parts.
  const arrayJoin = body.match(/description\s*:\s*\[([\s\S]*?)\]\.join\(/)
  if (arrayJoin) {
    const parts = [...arrayJoin[1]!.matchAll(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g)]
      .map((match) => stringLiteral(match[1]!))
      .filter((value): value is string => value !== null)
    if (parts.length > 0) return parts.join(" ")
  }

  // `description: IDENTIFIER` — imported .txt content or a module-level literal.
  const plain = body.match(/description\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/)
  if (plain) {
    const value = await resolveDescriptionSource(file, source, plain[1]!)
    if (value) return value
  }

  // `description,` shorthand — a module-level const/let, possibly derived
  // from another identifier (`const description = DESCRIPTION.replace(...)`).
  if (/description\s*,/.test(body)) {
    const local = resolveIdentifier(source, "description")
    if (local) return local
    const derived = source.match(/(?:const|let)\s+description\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)/)
    if (derived) {
      const value = await resolveDescriptionSource(file, source, derived[1]!)
      if (value) return value
    }
  }

  // `get description() { return X }` — resolve X the same way.
  const getter = body.match(/get\s+description\(\)\s*\{([\s\S]*?)\n\s*\}/)
  if (getter) {
    const identifiers = [...getter[1]!.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]!)
    for (const identifier of identifiers) {
      const value = await resolveDescriptionSource(file, source, identifier)
      if (value) return value
    }
  }
  return null
}

export function parseTaxonomy(source: string): (name: string) => string {
  const exact = new Map<string, string>()
  const registryBlock = findBlock(source, "const REGISTRY", "{", "}")
  if (registryBlock) {
    for (const line of registryBlock.split("\n")) {
      const match = line.match(/^\s*(\w+)\s*:\s*entry\(\s*"([^"]+)"/)
      if (match) exact.set(match[1]!, match[2]!)
    }
  }

  const fallbacks: Array<{ source: string; flags: string; kind: string }> = []
  const fallbackBlock = findBlock(source, "const PATTERN_FALLBACKS", "[", "]")
  if (fallbackBlock) {
    const pattern = /pattern:\s*\/((?:\\.|[^/])*)\/([a-z]*),\s*kind:\s*"([^"]+)"/g
    for (const match of fallbackBlock.matchAll(pattern)) {
      fallbacks.push({ source: match[1]!, flags: match[2] ?? "", kind: match[3]! })
    }
  }

  const defaultMatch = source.match(/const\s+DEFAULT_ENTRY[^=]*=\s*entry\(\s*"([^"]+)"/)
  const defaultKind = defaultMatch?.[1] ?? "platform.external"

  return (name: string): string => {
    const exactKind = exact.get(name)
    if (exactKind) return exactKind
    for (const fallback of fallbacks) {
      let regex: RegExp | null = null
      try {
        regex = new RegExp(fallback.source, fallback.flags)
      } catch {
        regex = null
      }
      if (regex && regex.test(name)) return fallback.kind
    }
    return defaultKind
  }
}

async function parseToolFile(
  file: string,
  toolName: string,
  classify: (name: string) => string,
): Promise<ToolEntry | null> {
  const source = await readFile(file, "utf8").catch(() => "")
  if (!source.includes(`${toolName} = Tool.define`)) return null
  const defineMatch = source.match(
    new RegExp(`export const ${toolName} = Tool\\.define(?:<[^>]*>)?\\(\\s*"([^"]+)"\\s*,`),
  )
  if (!defineMatch) return null
  const id = defineMatch[1]!
  const body = findBlock(source, `${toolName} = Tool.define`, "(", ")")
  if (!body) return null

  const description = await descriptionOf(file, source, body)

  let parameters: Array<{ name: string; type: string | null; description: string | null; optional: boolean }> = []
  const paramsBlock = findBlock(body, "parameters", "{", "}")
  if (paramsBlock) {
    parameters = parseObjectFields(paramsBlock)
  } else if (/parameters\s*,/.test(body)) {
    const moduleParams = source.match(/const\s+parameters\s*=\s*z[\s\S]*?\.object\(\{/)
    if (moduleParams) {
      const openIndex = source.indexOf(".object({", moduleParams.index! + moduleParams[0]!.length - 2)
      if (openIndex > 0) {
        const objectBlock = findBlock(source.slice(openIndex), "{", "{", "}")
        if (objectBlock) parameters = parseObjectFields(objectBlock)
      }
    }
  }

  return { id, file: path.relative(REPO_ROOT, file), description, kind: classify(id), parameters }
}

export async function generate(): Promise<string> {
  const registry = await readFile(REGISTRY, "utf8")
  const taxonomy = await readFile(TAXONOMY, "utf8")
  const classify = parseTaxonomy(taxonomy)
  const tools: ToolEntry[] = []
  for (const name of builtinNames(registry)) {
    const file = await resolveToolFile(name, registry)
    if (!file) continue
    const entry = await parseToolFile(file, name, classify)
    if (entry) tools.push(entry)
  }
  for (const domain of await domainRegistries()) {
    for (const name of builtinNames(domain.source)) {
      const file = await resolveToolFile(name, domain.source, domain.dir)
      if (!file) continue
      const entry = await parseToolFile(file, name, classify)
      if (entry && !tools.some((existing) => existing.id === entry.id)) tools.push(entry)
    }
  }
  tools.sort((a, b) => a.id.localeCompare(b.id))

  const lines: string[] = [
    "# Tools Reference",
    "",
    "Generated from the builtin tool registry in `packages/synergy/src/tool/registry.ts` and the canonical taxonomy in `packages/synergy/src/tool/taxonomy.ts`.",
    "",
    "## Tools",
    "",
    "| Tool | Kind | Description |",
    "| --- | --- | --- |",
  ]
  for (const tool of tools) {
    const summary = tool.description?.replace(/\s+/g, " ").slice(0, 200) ?? ""
    lines.push(`| \`${tool.id}\` | \`${tool.kind}\` | ${mdCell(summary)} |`)
  }
  for (const tool of tools) {
    lines.push("", `## ${tool.id}`, "", `Kind: \`${tool.kind}\``, "")
    if (tool.description) lines.push(tool.description.replace(/\s+/g, " ").trim(), "")
    if (tool.parameters.length > 0) {
      lines.push("| Parameter | Type | Required | Description |", "| --- | --- | --- | --- |")
      for (const param of tool.parameters) {
        const required = param.optional ? "" : "yes"
        const description = param.description?.replace(/\s+/g, " ") ?? ""
        lines.push(`| \`${param.name}\` | ${mdCell(param.type ?? "-")} | ${required} | ${mdCell(description)} |`)
      }
    }
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const body = await generate()
  if (process.argv.includes("--check")) {
    if (await isFresh(OUT, GENERATOR, body)) {
      console.log(`${GENERATOR}: fresh`)
      process.exit(0)
    }
    console.error(`${GENERATOR}: docs/reference/tools.md is stale — run bun script/gen/${GENERATOR}`)
    process.exit(1)
  }
  await writeGenerated(OUT, GENERATOR, body)
  console.log("wrote docs/reference/tools.md")
}
