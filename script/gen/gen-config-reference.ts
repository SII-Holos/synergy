#!/usr/bin/env bun

/**
 * Generates docs/reference/configuration.md from the static config domain
 * definitions (packages/synergy/src/config/domain.ts) and the Zod schema
 * (packages/synergy/src/config/schema.ts). Deterministic; supports --check.
 */

import path from "node:path"
import { readFile } from "node:fs/promises"
import {
  findBlock,
  isFresh,
  matchClose,
  mdCell,
  parseObjectFields,
  REPO_ROOT,
  stringLiteral,
  writeGenerated,
  type ObjectField,
} from "./shared"

const DOMAIN = path.join(REPO_ROOT, "packages/synergy/src/config/domain.ts")
const SCHEMA = path.join(REPO_ROOT, "packages/synergy/src/config/schema.ts")
const OUT = path.join(REPO_ROOT, "docs/reference/configuration.md")
const GENERATOR = "gen-config-reference.ts"

interface Domain {
  id: string
  filename: string
  label: string
  ownedKeys: string[]
  mergePolicy: string
}

function readStringAt(call: string, index: number): { value: string; end: number } | null {
  const rest = call.slice(index).replace(/^\s*,\s*/, "")
  const match = rest.match(/^\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*')/)
  if (!match) return null
  return { value: stringLiteral(match[1]!)!, end: index + call.slice(index).length - rest.length + match[0]!.length }
}

export function parseDefCall(call: string): Domain | null {
  let cursor = 0
  const id = readStringAt(call, cursor)
  if (!id) return null
  cursor = id.end
  const filename = readStringAt(call, cursor)
  if (!filename) return null
  cursor = filename.end
  const label = readStringAt(call, cursor)
  if (!label) return null
  cursor = label.end
  const ownedKeys: string[] = []
  const keysOpen = call.indexOf("[", cursor)
  if (keysOpen >= 0) {
    const keysClose = call.lastIndexOf("]")
    if (keysClose > keysOpen) {
      for (const key of call.slice(keysOpen + 1, keysClose).matchAll(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g)) {
        const value = stringLiteral(key[1]!)
        if (value) ownedKeys.push(value)
      }
      cursor = keysClose + 1
    }
  }
  const merge = readStringAt(call, cursor)
  return { id: id.value, filename: filename.value, label: label.value, ownedKeys, mergePolicy: merge?.value ?? "merge" }
}

function splitTopLevelEntries(block: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = 0
  let inString: "'" | '"' | null = null
  let inTemplate = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < block.length; i++) {
    const c = block[i]!
    const prev = i > 0 ? block[i - 1] : ""
    if (inLineComment) {
      if (c === "\n") inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (c === "*" && block[i + 1] === "/") {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inTemplate) {
      if (c === "`" && prev !== "\\") inTemplate = false
      continue
    }
    if (inString) {
      if (c === inString && prev !== "\\") inString = null
      continue
    }
    if (c === "/" && block[i + 1] === "/") {
      inLineComment = true
      continue
    }
    if (c === "/" && block[i + 1] === "*") {
      inBlockComment = true
      continue
    }
    if (c === "'" || c === '"') {
      inString = c
      continue
    }
    if (c === "`") {
      inTemplate = true
      continue
    }
    if (c === "{" || c === "(" || c === "[") depth++
    else if (c === "}" || c === ")" || c === "]") depth--
    else if (c === "," && depth === 0) {
      entries.push(block.slice(start, i))
      start = i + 1
    }
  }
  entries.push(block.slice(start))
  return entries
}

export function parseDomainObject(body: string): Domain | null {
  const stringField = (key: string) => {
    const match = body.match(new RegExp(`\\b${key}\\s*:\\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*')`))
    return match ? stringLiteral(match[1]!) : null
  }
  const id = stringField("id")
  const filename = stringField("filename")
  const label = stringField("label")
  if (!id || !filename || !label) return null
  const ownedKeys: string[] = []
  const keysMatch = body.match(/\bownedKeys\s*:\s*\[/)
  if (keysMatch) {
    const keysStart = keysMatch.index! + keysMatch[0]!.length
    const keysClose = matchClose(body, keysStart - 1, "[", "]")
    if (keysClose >= 0) {
      for (const key of body.slice(keysStart, keysClose).matchAll(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g)) {
        const value = stringLiteral(key[1]!)
        if (value) ownedKeys.push(value)
      }
    }
  }
  const mergePolicy = stringField("mergePolicy")
  return { id, filename, label, ownedKeys, mergePolicy: mergePolicy ?? "merge" }
}

async function parseDomains(): Promise<Domain[]> {
  const source = await readFile(DOMAIN, "utf8")
  const block = findBlock(source, "export const definitions = ", "[", "]")
  if (!block) return []
  const domains: Domain[] = []
  for (const entry of splitTopLevelEntries(block)) {
    const trimmed = entry.trim()
    if (trimmed.startsWith("def(")) {
      const call = findBlock(entry, "def", "(", ")")
      const domain = call ? parseDefCall(call) : null
      if (domain) domains.push(domain)
    } else if (trimmed.startsWith("{")) {
      const open = trimmed.indexOf("{")
      const close = matchClose(trimmed, open, "{", "}")
      const domain = close >= 0 ? parseDomainObject(trimmed.slice(open + 1, close)) : null
      if (domain) domains.push(domain)
    }
  }
  return domains
}

async function infoFields(): Promise<ObjectField[]> {
  const source = await readFile(SCHEMA, "utf8")
  const block = findBlock(source, "export const Info = z", "(", ")")
  return block ? parseObjectFields(block) : []
}

export async function generate(): Promise<string> {
  const domains = await parseDomains()
  const info = await infoFields()
  const byKey = new Map(info.map((field) => [field.name, field]))

  const lines: string[] = [
    "# Configuration Reference",
    "",
    "Generated from the config domain definitions in `packages/synergy/src/config/domain.ts` and the Zod schema in `packages/synergy/src/config/schema.ts`. Concept and layout guidance lives in [Configuration layout](configuration-layout.md).",
    "",
    "## Domains",
    "",
    "| Domain | File | Merge policy |",
    "| --- | --- | --- |",
  ]
  for (const domain of domains) {
    lines.push(`| \`${domain.id}\` | \`${domain.filename}\` | ${domain.mergePolicy} |`)
  }

  for (const domain of domains) {
    lines.push("", `## ${domain.label}`, "", `File: \`${domain.filename}\` · Merge: ${domain.mergePolicy}`, "")
    lines.push("| Key | Type | Description |", "| --- | --- | --- |")
    for (const key of domain.ownedKeys) {
      const field = byKey.get(key)
      const typeName = field?.type ?? "-"
      const optional = field?.optional ? " (optional)" : ""
      const description = field?.description ?? ""
      lines.push(`| \`${key}\` | ${mdCell(typeName)}${optional} | ${mdCell(description)} |`)
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
    console.error(`${GENERATOR}: docs/reference/configuration.md is stale — run bun script/gen/${GENERATOR}`)
    process.exit(1)
  }
  await writeGenerated(OUT, GENERATOR, body)
  console.log("wrote docs/reference/configuration.md")
}
