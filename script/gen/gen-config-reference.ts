#!/usr/bin/env bun

/**
 * Generates docs/reference/configuration.md from the static config domain
 * definitions and owner schemas selected by product-runtime configuration.
 * Deterministic; supports --check.
 */

import path from "node:path"
import ts from "typescript"
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

const SCHEMA = path.join(REPO_ROOT, "packages/harness/src/config/schema.ts")
const COMPOSITION = path.join(REPO_ROOT, "packages/product-runtime/src/configuration.ts")
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

async function ownerSchemaPaths(): Promise<string[]> {
  const composition = await readFile(COMPOSITION, "utf8")
  return [...composition.matchAll(/import\s+"([^"]+\/config-schema)"/g)].map((match) =>
    Bun.resolveSync(match[1]!, COMPOSITION),
  )
}

async function parseDomains(): Promise<Domain[]> {
  const files = [path.join(REPO_ROOT, "packages/harness/src/config/domain.ts"), ...(await ownerSchemaPaths())]
  const domains = new Map<string, Domain>()
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true)
    function collect(expression: ts.Expression) {
      const array = ts.isSatisfiesExpression(expression) ? expression.expression : expression
      if (!ts.isArrayLiteralExpression(array)) return
      for (const entry of array.elements) {
        const domain = ts.isObjectLiteralExpression(entry)
          ? parseDomainObject(entry.getText(source))
          : ts.isCallExpression(entry)
            ? parseDefCall(entry.arguments.map((arg) => arg.getText(source)).join(", "))
            : null
        if (!domain) continue
        const current = domains.get(domain.id)
        if (current) {
          if (current.filename !== domain.filename)
            throw new Error(`Configuration domain filename conflict: ${domain.id}`)
          current.ownedKeys = [...new Set([...current.ownedKeys, ...domain.ownedKeys])]
        } else domains.set(domain.id, domain)
      }
    }
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "definitions" && node.initializer)
        collect(node.initializer)
      if (ts.isForOfStatement(node) && node.initializer.getText(source) === "const domain") collect(node.expression)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...domains.values()].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
}

async function infoFields(): Promise<ObjectField[]> {
  const owners = await ownerSchemaPaths()
  const sources = await Promise.all([SCHEMA, ...owners].map((file) => readFile(file, "utf8")))
  return sources.flatMap((source, index) => {
    const block =
      index === 0
        ? findBlock(source, "const CoreInfo = z", "(", ")")
        : findBlock(source, "export const ConfigShape = ", "{", "}")
    if (!block) throw new Error(`Configuration schema fields missing for ${index === 0 ? SCHEMA : owners[index - 1]}`)
    return parseObjectFields(index === 0 ? block : `{${block}}`)
  })
}

export async function generate(): Promise<string> {
  const domains = await parseDomains()
  const info = await infoFields()
  const byKey = new Map(info.map((field) => [field.name, field]))

  const lines: string[] = [
    "# Configuration Reference",
    "",
    "Generated from `packages/harness/src/config/domain.ts` and the domain-owned configuration schemas composed by `packages/product-runtime/src/configuration.ts`. Concept and layout guidance lives in [Configuration layout](configuration-layout.md).",
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
      if (!field) throw new Error(`Configuration reference missing owned field ${key}`)
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
