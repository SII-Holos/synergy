#!/usr/bin/env bun
import { decodePoString } from "./po-string"

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
 * Dynamic descriptors passed directly to translation calls → hard error.
 * Descriptor-shaped objects with a static ID and an unresolved local message → hard error.
 * Imported descriptors remain external and are skipped for their owning module to extract.
 * Preserves zh-CN translations, translator comments, and file/line locations.
 */

import ts from "typescript"
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import path from "node:path"

const LOCALES = ["en", "zh-CN", "pseudo"]

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

type Evaluation = { kind: "value"; value: string } | { kind: "external" } | { kind: "dynamic" }

type EvaluationContext = {
  sourceFile: ts.SourceFile
  imports: Set<string>
  bindings: Map<string, ts.Expression>
  functions: Map<string, ts.FunctionLikeDeclaration>
}

function createEvaluationContext(sourceFile: ts.SourceFile): EvaluationContext {
  const imports = new Set<string>()
  const bindings = new Map<string, ts.Expression>()
  const functions = new Map<string, ts.FunctionLikeDeclaration>()

  function collect(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      if (node.importClause.name) imports.add(node.importClause.name.text)
      const named = node.importClause.namedBindings
      if (named && ts.isNamespaceImport(named)) imports.add(named.name.text)
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) imports.add(element.name.text)
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer)
      const initializer = unwrapExpression(node.initializer)
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        functions.set(node.name.text, initializer)
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
    ts.forEachChild(node, collect)
  }

  collect(sourceFile)
  return { sourceFile, imports, bindings, functions }
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrapExpression(expression)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression)
  }
  return ts.isIdentifier(current) ? current : undefined
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function resolveReference(
  expression: ts.Expression,
  context: EvaluationContext,
  seen: Set<ts.Node>,
): ts.Expression | undefined {
  const current = unwrapExpression(expression)
  if (seen.has(current)) return
  seen.add(current)

  if (ts.isIdentifier(current)) return context.bindings.get(current.text)
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return current

  const root = rootIdentifier(current)
  if (root && context.imports.has(root.text)) return

  const key = ts.isPropertyAccessExpression(current)
    ? current.name.text
    : current.argumentExpression && ts.isStringLiteralLike(current.argumentExpression)
      ? current.argumentExpression.text
      : undefined
  if (!key) return

  const ownerReference = resolveReference(current.expression, context, new Set(seen))
  const owner = ownerReference ? unwrapExpression(ownerReference) : unwrapExpression(current.expression)
  if (!ts.isObjectLiteralExpression(owner)) return

  for (const property of owner.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === key) return property.initializer
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name
  }
  return
}

function evaluateExpression(
  expression: ts.Expression,
  context: EvaluationContext,
  seen = new Set<ts.Node>(),
): Evaluation {
  const current = unwrapExpression(expression)
  if (seen.has(current)) return { kind: "dynamic" }
  seen.add(current)

  if (ts.isStringLiteralLike(current)) return { kind: "value", value: current.text }

  if (ts.isTemplateExpression(current)) {
    const parts = [current.head.text]
    for (const span of current.templateSpans) {
      const value = evaluateExpression(span.expression, context, new Set(seen))
      if (value.kind !== "value") return value
      parts.push(value.value, span.literal.text)
    }
    return { kind: "value", value: parts.join("") }
  }

  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateExpression(current.left, context, new Set(seen))
    const right = evaluateExpression(current.right, context, new Set(seen))
    if (left.kind === "external" || right.kind === "external") return { kind: "external" }
    if (left.kind !== "value" || right.kind !== "value") return { kind: "dynamic" }
    return { kind: "value", value: left.value + right.value }
  }

  const root = rootIdentifier(current)
  if (root && context.imports.has(root.text)) return { kind: "external" }

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const resolved = resolveReference(current, context, new Set())
    if (!resolved || resolved === current) return { kind: "dynamic" }
    return evaluateExpression(resolved, context, new Set(seen))
  }

  return { kind: "dynamic" }
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1
}

function leadingComment(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const full = sourceFile.getFullText()
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    const ranges = ts.getLeadingCommentRanges(full, current.getFullStart())
    if (!ranges?.length) continue
    const comment = full.slice(ranges.at(-1)!.pos, ranges.at(-1)!.end).trim()
    if (comment.startsWith("//")) return comment.slice(2).trim()
    if (comment.startsWith("/*")) {
      const inner = comment.slice(2, -2).trim()
      return inner.startsWith("*") ? inner.slice(1).trim() : inner
    }
  }
  return undefined
}

function descriptorProperties(object: ts.ObjectLiteralExpression): {
  id?: ts.Expression
  message?: ts.Expression
} {
  let id: ts.Expression | undefined
  let message: ts.Expression | undefined
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name)
      if (name === "id") id = property.initializer
      if (name === "message") message = property.initializer
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === "id") id = property.name
      if (property.name.text === "message") message = property.name
    }
  }
  return { id, message }
}

function isTranslationCallee(expression: ts.LeftHandSideExpression): boolean {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return current.text === "_" || current.text === "t"
  return ts.isPropertyAccessExpression(current) && (current.name.text === "_" || current.name.text === "t")
}

function translationCallForObject(object: ts.ObjectLiteralExpression): ts.CallExpression | undefined {
  let current: ts.Node = object
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent
  }
  const parent = current.parent
  if (!parent || !ts.isCallExpression(parent) || !parent.arguments.includes(current as ts.Expression)) return
  return isTranslationCallee(parent.expression) ? parent : undefined
}

function recordDescriptor(
  object: ts.ObjectLiteralExpression,
  context: EvaluationContext,
  entries: DescriptorEntry[],
  errors: ExtractionError[],
): void {
  const properties = descriptorProperties(object)
  if (!properties.id && !properties.message) return

  const translationCall = translationCallForObject(object)
  const id = properties.id ? evaluateExpression(properties.id, context) : { kind: "dynamic" as const }
  const message = properties.message ? evaluateExpression(properties.message, context) : { kind: "dynamic" as const }

  if (id.kind === "value" && message.kind === "value") {
    entries.push({
      id: id.value,
      message: message.value,
      file: context.sourceFile.fileName,
      line: lineOf(object, context.sourceFile),
      translatorComment: leadingComment(object, context.sourceFile),
    })
    return
  }

  if (!translationCall) {
    if (id.kind === "value" && properties.message && message.kind === "dynamic") {
      errors.push({
        file: context.sourceFile.fileName,
        line: lineOf(object, context.sourceFile),
        message: "Message must resolve to a static string",
      })
    }
    return
  }
  if (id.kind === "external" && message.kind === "external") return

  if (!properties.id) {
    errors.push({
      file: context.sourceFile.fileName,
      line: lineOf(object, context.sourceFile),
      message: "Message descriptor is missing an ID",
    })
  } else if (id.kind !== "value" && id.kind !== "external") {
    errors.push({
      file: context.sourceFile.fileName,
      line: lineOf(object, context.sourceFile),
      message: "ID must resolve to a static string",
    })
  }

  if (!properties.message) {
    errors.push({
      file: context.sourceFile.fileName,
      line: lineOf(object, context.sourceFile),
      message: "Message descriptor is missing a default message",
    })
  } else if (message.kind !== "value" && message.kind !== "external") {
    errors.push({
      file: context.sourceFile.fileName,
      line: lineOf(object, context.sourceFile),
      message: "Message must resolve to a static string",
    })
  }
}

function functionReturnObjects(node: ts.FunctionLikeDeclaration): ts.ObjectLiteralExpression[] {
  if (!node.body) return []
  const body = unwrapExpression(node.body as ts.Expression)
  if (!ts.isBlock(node.body)) return ts.isObjectLiteralExpression(body) ? [body] : []
  const objects: ts.ObjectLiteralExpression[] = []
  function collect(current: ts.Node): void {
    if (current !== node.body && ts.isFunctionLike(current)) return
    if (ts.isReturnStatement(current) && current.expression) {
      const expression = unwrapExpression(current.expression)
      if (ts.isObjectLiteralExpression(expression)) objects.push(expression)
      if (ts.isConditionalExpression(expression)) {
        const whenTrue = unwrapExpression(expression.whenTrue)
        const whenFalse = unwrapExpression(expression.whenFalse)
        if (ts.isObjectLiteralExpression(whenTrue)) objects.push(whenTrue)
        if (ts.isObjectLiteralExpression(whenFalse)) objects.push(whenFalse)
      }
    }
    ts.forEachChild(current, collect)
  }
  collect(node.body)
  return objects
}

function recordDescriptorFactoryCall(
  call: ts.CallExpression,
  context: EvaluationContext,
  entries: DescriptorEntry[],
): void {
  if (!ts.isIdentifier(call.expression)) return
  const fn = context.functions.get(call.expression.text)
  if (!fn) return
  const bindings = new Map(context.bindings)
  fn.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name) && call.arguments[index])
      bindings.set(parameter.name.text, call.arguments[index]!)
  })
  const callContext = { ...context, bindings }
  for (const object of functionReturnObjects(fn)) {
    const allowed = object.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) return true
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false
      const name = propertyName(property.name)
      return name === "id" || name === "message" || name === "values" || name === "comment"
    })
    if (!allowed) continue
    const properties = descriptorProperties(object)
    if (!properties.id || !properties.message) continue
    const id = evaluateExpression(properties.id, callContext)
    const message = evaluateExpression(properties.message, callContext)
    if (id.kind !== "value" || message.kind !== "value") continue
    entries.push({
      id: id.value,
      message: message.value,
      file: context.sourceFile.fileName,
      line: lineOf(call, context.sourceFile),
      translatorComment: leadingComment(call, context.sourceFile),
    })
  }
}

function jsxAttribute(opening: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === name,
  )
}

function jsxAttributeExpression(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
  if (!attribute?.initializer) return
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer
  if (ts.isJsxExpression(attribute.initializer)) return attribute.initializer.expression
  return
}

function recordTransElement(
  opening: ts.JsxOpeningLikeElement,
  context: EvaluationContext,
  entries: DescriptorEntry[],
  errors: ExtractionError[],
): void {
  if (!ts.isIdentifier(opening.tagName) || opening.tagName.text !== "Trans") return
  const idExpression = jsxAttributeExpression(jsxAttribute(opening, "id"))
  const messageExpression = jsxAttributeExpression(jsxAttribute(opening, "message"))
  const id = idExpression ? evaluateExpression(idExpression, context) : { kind: "dynamic" as const }
  const message = messageExpression ? evaluateExpression(messageExpression, context) : { kind: "dynamic" as const }

  if (id.kind === "value" && message.kind === "value") {
    entries.push({
      id: id.value,
      message: message.value,
      file: context.sourceFile.fileName,
      line: lineOf(opening, context.sourceFile),
      translatorComment: leadingComment(opening, context.sourceFile),
    })
    return
  }
  if (id.kind === "external" && message.kind === "external") return

  if (id.kind !== "value" && id.kind !== "external") {
    errors.push({
      file: context.sourceFile.fileName,
      line: lineOf(opening, context.sourceFile),
      message: "Trans ID must resolve to a static string",
    })
  }
  if (message.kind !== "value" && message.kind !== "external") {
    errors.push({
      file: context.sourceFile.fileName,
      line: lineOf(opening, context.sourceFile),
      message: "Trans message must resolve to a static string",
    })
  }
}

export function extractFromFile(sourceFile: ts.SourceFile): {
  entries: DescriptorEntry[]
  errors: ExtractionError[]
} {
  const entries: DescriptorEntry[] = []
  const errors: ExtractionError[] = []
  const context = createEvaluationContext(sourceFile)

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) recordDescriptor(node, context, entries, errors)
    if (ts.isCallExpression(node)) recordDescriptorFactoryCall(node, context, entries)
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      recordTransElement(node, context, entries, errors)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { entries, errors }
}

export function readExistingPo(root: string, locale: string): Map<string, string> {
  const messages = new Map<string, string>()
  const file = path.join(root, locale, "messages.po")
  if (!existsSync(file)) return messages
  const entries = /msgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"/g

  for (const match of readFileSync(file, "utf-8").matchAll(entries)) {
    messages.set(decodePoString(match[1] ?? ""), decodePoString(match[2] ?? ""))
  }

  return messages
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
  writeFileSync(path.join(dir, "messages.po"), out.join("\n"))
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
