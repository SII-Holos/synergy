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

async function parseDomains(): Promise<Domain[]> {
  const source = await readFile(DOMAIN, "utf8")
  const block = findBlock(source, "export const definitions = ", "[", "]")
  if (!block) return []
  const domains: Domain[] = []
  for (const match of block.matchAll(/\bdef\s*\(/g)) {
    const call = findBlock(block.slice(match.index!), "def", "(", ")")
    if (!call) continue
    const domain = parseDefCall(call)
    if (domain) domains.push(domain)
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
