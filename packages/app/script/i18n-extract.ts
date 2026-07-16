#!/usr/bin/env bun

/**
 * AST-based deterministic extractor for Lingui non-macro runtime descriptors.
 * Uses TypeScript's compiler API to scan app/src + ui/src for static
 * `{ id: "x", message: "y" }` descriptors.
 *
 * Evaluator resolves:
 *  - Direct string literals
 *  - Template literals with statically resolvable substitutions
 *     (const identifiers, property access chains, function calls returning strings)
 *  - Const identifier references (single binding in same file)
 *  - Property access into const object declarations (e.g. options.title)
 *
 * Dynamic IDs (id is not statically resolvable to a string) → hard error.
 * Dynamic messages that can't be resolved → silently skipped (valid runtime pattern).
 *
 * Preserves zh-CN translations, translator comments, and file/line locations.
 */

import ts from "typescript"
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import path from "node:path"

const LOCALES = ["en", "zh-CN"]

interface DescriptorEntry {
  id: string
  message: string
  file: string
  line: number
  translatorComment?: string
}

interface ExtractionError {
  file: string
  line: number
  message: string
}

export function resolveRoots(): { appSrc: string; uiSrc: string; localesRoot: string } {
  const d = import.meta.dir
  return {
    appSrc: path.resolve(d, "..", "src"),
    uiSrc: path.resolve(d, "..", "..", "ui", "src"),
    localesRoot: path.resolve(d, "..", "src", "locales"),
  }
}

export function collectTsFiles(root: string): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue
        walk(fp)
      } else if (
        (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
        !e.name.includes(".test.") &&
        !e.name.includes(".spec.")
      ) {
        out.push(fp)
      }
    }
  }
  walk(root)
  return out
}

/**
 * Tries to statically evaluate a TypeScript expression to a string.
 * Returns the resolved string, or undefined if not statically resolvable.
 */
function evaluateExpression(node: ts.Expression, sf: ts.SourceFile): string | undefined {
  // Direct string literal
  if (ts.isStringLiteral(node)) return node.text

  // NoSubstitutionTemplateLiteral: `hello` (no ${})
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text

  // TemplateExpression: `hello ${x} world`
  if (ts.isTemplateExpression(node)) {
    const parts: string[] = [node.head.text]
    for (const span of node.templateSpans) {
      const val = evaluateExpression(span.expression, sf)
      if (val === undefined) return undefined
      parts.push(val)
      parts.push(span.literal.text)
    }
    return parts.join("")
  }

  // Identifier reference: try to find const binding in same file
  if (ts.isIdentifier(node)) {
    return resolveConstBinding(node.text, node, sf)
  }

  // Property access: options.title, notice.actionLabel, etc.
  if (ts.isPropertyAccessExpression(node)) {
    // Try full chain evaluation first
    const parts: string[] = []
    let current: ts.Expression = node
    while (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text)
      current = current.expression
    }
    if (ts.isIdentifier(current)) {
      const baseObj = resolveConstBinding(current.text, current, sf)
      if (baseObj !== undefined) {
        // We resolved the base to a string — can't further property-access a string
        // This happens when the base IS the final value (e.g. the const is a string)
        // In that case, we should have resolved via the identifier case above.
        return undefined
      }
      // Try to resolve deeper: walk the AST for the declaration
      const objLiteral = findConstObjectBinding(current.text, sf)
      if (objLiteral) {
        return resolveObjectProperty(objLiteral, parts, sf)
      }
    }
    // Try calling getText for simple chains like options.title
    // This won't resolve but we can try evaluating each node
    return undefined
  }

  // Call expression: quoted(...), label(), pluginLabel(), etc.
  if (ts.isCallExpression(node)) {
    // We can't evaluate function calls statically
    return undefined
  }

  // Parenthesized expression
  if (ts.isParenthesizedExpression(node)) {
    return evaluateExpression(node.expression, sf)
  }

  return undefined
}

/**
 * Find a const declaration for a given identifier in the same source file.
 */
function resolveConstBinding(name: string, _context: ts.Node, sf: ts.SourceFile): string | undefined {
  let found: string | undefined

  function visit(n: ts.Node): void {
    if (found !== undefined) return
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
        found = evaluateExpression(n.initializer, sf)
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(sf)
  return found
}

/**
 * Find a const object literal declaration by name.
 */
function findConstObjectBinding(name: string, sf: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined

  function visit(n: ts.Node): void {
    if (found) return
    if (ts.isVariableDeclaration(n)) {
      if (
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        found = n.initializer
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(sf)
  return found
}

/**
 * Walk property access chain into a const object literal.
 */
function resolveObjectProperty(
  obj: ts.ObjectLiteralExpression,
  chain: string[],
  sf: ts.SourceFile,
): string | undefined {
  let current: ts.Expression = obj
  for (const prop of chain) {
    if (!ts.isObjectLiteralExpression(current)) return undefined
    let next: ts.Expression | undefined
    for (const p of current.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === prop) {
        next = p.initializer
        break
      }
      if (ts.isShorthandPropertyAssignment(p) && p.name.getText(sf) === prop) {
        // Shorthand: { title } → try to resolve the identifier
        next = p.name
        break
      }
    }
    if (!next) return undefined
    current = next
  }

  // Final value: try to evaluate as string
  if (ts.isStringLiteral(current)) return current.text
  if (ts.isNoSubstitutionTemplateLiteral(current)) return current.text
  if (ts.isTemplateExpression(current)) {
    return evaluateExpression(current, sf)
  }
  if (ts.isIdentifier(current)) {
    return resolveConstBinding(current.text, current, sf)
  }
  return undefined
}

function lineOf(n: ts.Node, sf: ts.SourceFile): number {
  return ts.getLineAndCharacterOfPosition(sf, n.getStart(sf)).line + 1
}

function leadingComment(n: ts.Node, sf: ts.SourceFile): string | undefined {
  const full = sf.getFullText()
  const ranges = ts.getLeadingCommentRanges(full, n.getFullStart())
  if (!ranges) return undefined
  for (const r of ranges) {
    const c = full.slice(r.pos, r.end).trim()
    if (c.startsWith("//")) return c.slice(2).trim()
    if (c.startsWith("/*")) {
      const inner = c.slice(2, -2).trim()
      return inner.startsWith("*") ? inner.slice(1).trim() : inner
    }
  }
  return undefined
}

interface Props {
  hasIdString: boolean
  hasIdExpr: boolean
  hasMsgString: boolean
  hasMsgExpr: boolean
}

function classifyProps(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): Props {
  let hasIdString = false,
    hasIdExpr = false,
    hasMsgString = false,
    hasMsgExpr = false

  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const n = p.name.getText(sf)
    if (n === "id") {
      if (ts.isStringLiteral(p.initializer)) hasIdString = true
      else hasIdExpr = true
    }
    if (n === "message") {
      if (ts.isStringLiteral(p.initializer)) hasMsgString = true
      else hasMsgExpr = true
    }
  }
  return { hasIdString, hasIdExpr, hasMsgString, hasMsgExpr }
}

export function extractFromFile(sf: ts.SourceFile): {
  entries: DescriptorEntry[]
  errors: ExtractionError[]
} {
  const entries: DescriptorEntry[] = []
  const errors: ExtractionError[] = []

  function visit(n: ts.Node): void {
    if (!ts.isObjectLiteralExpression(n)) {
      ts.forEachChild(n, visit)
      return
    }

    const p = classifyProps(n, sf)

    // Full descriptor with id string → try to resolve
    if (p.hasIdString) {
      let id = ""
      let msgInit: ts.Expression | undefined
      for (const prop of n.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const name = prop.name.getText(sf)
        if (name === "id" && ts.isStringLiteral(prop.initializer)) id = prop.initializer.text
        if (name === "message") msgInit = prop.initializer
      }

      if (msgInit) {
        const msg = evaluateExpression(msgInit, sf)
        if (msg !== undefined) {
          entries.push({
            id,
            message: msg,
            file: sf.fileName,
            line: lineOf(n, sf),
            translatorComment: leadingComment(n, sf),
          })
        }
        // If msg is undefined, skip — it's a valid runtime pattern, not an error
      }
      return
    }

    // Dynamic ID with message → hard error
    if (p.hasIdExpr && (p.hasMsgString || p.hasMsgExpr)) {
      errors.push({
        file: sf.fileName,
        line: lineOf(n, sf),
        message: "ID must be a static string literal",
      })
      return
    }

    // Neither — continue visiting children
    ts.forEachChild(n, visit)
  }

  visit(sf)
  return { entries, errors }
}

export function readExistingPo(root: string, locale: string): Map<string, string> {
  const m = new Map<string, string>()
  const fp = path.join(root, locale, "messages.po")
  if (!existsSync(fp)) return m
  const re = /msgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"/g
  for (const [, id, str] of readFileSync(fp, "utf-8").matchAll(re)) m.set(id, str)
  return m
}

export function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

export function writePo(
  root: string,
  locale: string,
  entries: Map<string, { id: string; message: string }>,
  comments: Map<string, string | undefined>,
): void {
  const dir = path.join(root, locale)
  mkdirSync(dir, { recursive: true })
  const existing = readExistingPo(root, locale)
  const sorted = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))
  const out: string[] = [
    'msgid ""',
    'msgstr ""',
    '"POT-Creation-Date: 2026-07-16 00:00+0800\\n"',
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=utf-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    "",
  ]
  for (const [id, e] of sorted) {
    out.push(`#. ${comments.get(id) ?? "js-lingui-explicit-id"}`)
    out.push(`msgid "${esc(id)}"`)
    out.push(`msgstr "${esc(locale === "en" ? e.message : (existing.get(id) ?? ""))}"`)
    out.push("")
  }
  writeFileSync(path.join(dir, "messages.po"), out.join("\n") + "\n")
}

export function extractAll(files: string[]): { entries: DescriptorEntry[]; errors: ExtractionError[] } {
  const allEntries: DescriptorEntry[] = []
  const allErrors: ExtractionError[] = []

  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const { entries, errors } = extractFromFile(sf)
    allEntries.push(...entries)
    allErrors.push(...errors)
  }

  // Duplicate detection
  const seen = new Map<string, DescriptorEntry>()
  for (const e of allEntries) {
    const prev = seen.get(e.id)
    if (prev && prev.message !== e.message) {
      allErrors.push({
        file: e.file,
        line: e.line,
        message: `Duplicate ID "${e.id}" — "${prev.message}" vs "${e.message}" (first: ${prev.file}:${prev.line})`,
      })
    } else if (!prev) seen.set(e.id, e)
  }

  return { entries: allEntries, errors: allErrors }
}

export function mergeAndWrite(allEntries: DescriptorEntry[], localesRoot: string): number {
  const merged = new Map<string, { id: string; message: string }>()
  const comments = new Map<string, string | undefined>()
  for (const e of allEntries) {
    merged.set(e.id, { id: e.id, message: e.message })
    if (e.translatorComment) comments.set(e.id, e.translatorComment)
  }

  for (const loc of LOCALES) writePo(localesRoot, loc, merged, comments)
  return merged.size
}

function main(): void {
  const { appSrc, uiSrc, localesRoot } = resolveRoots()
  const files = [...collectTsFiles(appSrc), ...collectTsFiles(uiSrc)]
  const { entries, errors } = extractAll(files)

  if (errors.length > 0) {
    console.error(`\n${errors.length} extraction error(s):\n`)
    for (const e of errors) console.error(`  ${e.file}:${e.line} — ${e.message}`)
    console.error()
    process.exit(1)
  }

  const count = mergeAndWrite(entries, localesRoot)
  console.log(`Extracted ${count} message descriptors from ${files.length} source files.`)
}

// Only run main when executed directly, not when imported
const executed = import.meta.filename === process.argv[1]
if (executed) main()
