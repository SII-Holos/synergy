#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

export type LocalizationViolationKind =
  | "chinese-literal"
  | "dynamic-message-id"
  | "hardcoded-locale"
  | "invalid-message-descriptor"
  | "invalid-message-id"
  | "jsx-attribute"
  | "jsx-text"
  | "macro-import"
  | "missing-default-message"
  | "user-visible-property"

export type LocalizationViolation = {
  path: string
  kind: LocalizationViolationKind
  literal: string
  occurrence: number
  line: number
  column: number
}

export type LocalizationAllowlistCategory =
  | "brand"
  | "code"
  | "developer-output"
  | "machine-identifier"
  | "plugin-content"
  | "raw-error"
  | "user-content"

export type LocalizationAllowlistEntry = {
  path: string
  kind: LocalizationViolationKind
  literal: string
  occurrence: number
  category: LocalizationAllowlistCategory
  reason: string
}

const MESSAGE_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,}$/
const CHINESE_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const MACRO_MODULE = /^@lingui\/(?:core|solid)(?:\/macro)?$/
const USER_VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "ariaLabel",
  "description",
  "label",
  "placeholder",
  "title",
])
const USER_VISIBLE_PROPERTIES = new Set([
  "ariaLabel",
  "description",
  "emptyDescription",
  "emptyTitle",
  "errorDescription",
  "errorTitle",
  "label",
  "placeholder",
  "successDescription",
  "successTitle",
  "title",
])
const EXCLUDED_JSX_ELEMENTS = new Set(["code", "pre", "script", "style"])
const TO_LOCALE_METHOD = /^toLocale(?:DateString|String|TimeString)$/
const INTL_FORMATTER =
  /^(?:Collator|DateTimeFormat|DisplayNames|ListFormat|NumberFormat|PluralRules|RelativeTimeFormat|Segmenter)$/
const TRANSLATABLE_CHARACTER = /\p{L}/u
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..")
type DescriptorEnvironment = {
  sourceFile: ts.SourceFile
  imports: Set<string>
  variables: Map<string, ts.Expression>
  functions: Map<string, ts.FunctionLikeDeclaration>
}

export function analyzeLocalizationSource(filePath: string, source: string): LocalizationViolation[] {
  const normalizedPath = normalizePath(filePath)
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    normalizedPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: Omit<LocalizationViolation, "occurrence">[] = []
  const descriptorEnvironment = createDescriptorEnvironment(sourceFile)

  function report(kind: LocalizationViolationKind, node: ts.Node, literal: string) {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({
      path: normalizedPath,
      kind,
      literal: normalizeLiteral(literal),
      line: location.line + 1,
      column: location.character + 1,
    })
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text
      if (moduleName.endsWith("/macro") && MACRO_MODULE.test(moduleName)) {
        report("macro-import", node.moduleSpecifier, moduleName)
      }
    }

    if (ts.isJsxText(node) && !isInsideExcludedJsx(node)) {
      const text = normalizeLiteral(node.text)
      if (text) report("jsx-text", node, text)
    }

    if (ts.isJsxAttribute(node)) analyzeJsxAttribute(node, report)

    if (ts.isStringLiteralLike(node) && !isModuleSpecifier(node) && CHINESE_TEXT.test(node.text)) {
      report("chinese-literal", node, node.text)
    }

    if (ts.isPropertyAssignment(node)) analyzeUserVisibleProperty(node, report)

    if (ts.isNewExpression(node) || ts.isCallExpression(node)) analyzeHardcodedLocale(node, report)

    if (ts.isCallExpression(node) && isTranslationCall(node.expression)) {
      analyzeMessageCall(node, descriptorEnvironment, report)
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (jsxTagName(node.tagName) === "Trans") analyzeTransElement(node, report)
    }

    if (ts.isObjectLiteralExpression(node) && hasI18nMarker(node, source)) {
      analyzeMessageDescriptor(node, report)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  const occurrences = new Map<string, number>()
  return violations.map((violation) => {
    const key = `${violation.kind}\u0000${violation.literal}`
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    return { ...violation, occurrence }
  })
}

export function applyLocalizationAllowlist(
  violations: LocalizationViolation[],
  allowlist: LocalizationAllowlistEntry[],
): LocalizationViolation[] {
  const allowed = new Set(
    allowlist.map((entry) =>
      allowlistKey({
        ...entry,
        path: normalizePath(entry.path),
      }),
    ),
  )
  return violations.filter((violation) => !allowed.has(allowlistKey(violation)))
}

function analyzeJsxAttribute(
  node: ts.JsxAttribute,
  report: (kind: LocalizationViolationKind, node: ts.Node, literal: string) => void,
) {
  const name = node.name.getText()
  if (!USER_VISIBLE_ATTRIBUTES.has(name) || !node.initializer) return

  if (ts.isStringLiteral(node.initializer)) {
    const value = normalizeLiteral(node.initializer.text)
    if (value) report("jsx-attribute", node.initializer, value)
    return
  }

  if (!ts.isJsxExpression(node.initializer) || !node.initializer.expression) return
  for (const literal of visibleStringLiterals(node.initializer.expression)) {
    const value = normalizeLiteral(literal.text)
    if (value) report("jsx-attribute", literal, value)
  }
}

function analyzeUserVisibleProperty(
  node: ts.PropertyAssignment,
  report: (kind: LocalizationViolationKind, node: ts.Node, literal: string) => void,
) {
  const name = propertyName(node.name)
  if (!name || !USER_VISIBLE_PROPERTIES.has(name)) return
  if (isMessageDescriptorProperty(node) || isInsideTestData(node)) return

  if (ts.isStringLiteralLike(node.initializer)) {
    const value = normalizeLiteral(node.initializer.text)
    if (value) report("user-visible-property", node.initializer, value)
    return
  }

  for (const literal of visibleStringLiterals(node.initializer)) {
    const value = normalizeLiteral(literal.text)
    if (value) report("user-visible-property", literal, value)
  }
}

function analyzeHardcodedLocale(
  node: ts.CallExpression | ts.NewExpression,
  report: (kind: LocalizationViolationKind, node: ts.Node, literal: string) => void,
) {
  const first = node.arguments?.[0]
  if (!first || !ts.isStringLiteral(first)) return

  if (ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression.getText()
    const method = node.expression.name.text
    if ((owner === "Intl" && INTL_FORMATTER.test(method)) || TO_LOCALE_METHOD.test(method)) {
      report("hardcoded-locale", first, first.text)
    }
  }
}

function analyzeMessageCall(
  node: ts.CallExpression,
  environment: DescriptorEnvironment,
  report: (kind: LocalizationViolationKind, node: ts.Node, literal: string) => void,
) {
  const descriptor = node.arguments[0]
  if (!descriptor || !isStaticMessageDescriptorExpression(descriptor, environment, node, new Set())) {
    report("invalid-message-descriptor", node, descriptor?.getText() ?? "<missing>")
    return
  }

  for (const object of resolveDescriptorObjects(descriptor, environment, node, new Set())) {
    analyzeMessageDescriptor(object, report)
  }
}

function analyzeTransElement(
  node: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  report: (kind: LocalizationViolationKind, node: ts.Node, literal: string) => void,
) {
  const id = jsxAttribute(node, "id")
  const message = jsxAttribute(node, "message")

  if (!id) {
    report("dynamic-message-id", node, "<missing>")
  } else if (!id.initializer || !ts.isStringLiteral(id.initializer)) {
    report("dynamic-message-id", id.attribute, id.initializer?.getText() ?? "<missing>")
  } else if (!MESSAGE_ID.test(id.initializer.text)) {
    report("invalid-message-id", id.initializer, id.initializer.text)
  }

  if (
    !message ||
    !message.initializer ||
    !ts.isStringLiteral(message.initializer) ||
    !message.initializer.text.trim()
  ) {
    report("missing-default-message", message?.attribute ?? node, message?.initializer?.getText() ?? "<missing>")
  }
}

function analyzeMessageDescriptor(
  node: ts.ObjectLiteralExpression,
  report: (kind: LocalizationViolationKind, node: ts.Node, literal: string) => void,
) {
  const id = objectProperty(node, "id")
  const message = objectProperty(node, "message")

  if (!id || !ts.isStringLiteralLike(id.initializer)) {
    report("dynamic-message-id", id ?? node, id?.initializer.getText() ?? "<missing>")
  } else if (!MESSAGE_ID.test(id.initializer.text)) {
    report("invalid-message-id", id.initializer, id.initializer.text)
  }

  if (!message || !ts.isStringLiteralLike(message.initializer) || !message.initializer.text.trim()) {
    report("missing-default-message", message ?? node, message?.initializer.getText() ?? "<missing>")
  }
}

function isTranslationCall(expression: ts.LeftHandSideExpression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "_"
  if (!ts.isPropertyAccessExpression(expression)) return false
  if (expression.name.text !== "_" && expression.name.text !== "t") return false

  const owner = expression.expression
  if (ts.isCallExpression(owner) && ts.isIdentifier(owner.expression)) return owner.expression.text === "i18n"
  return /(?:^|\.)i18n$/.test(owner.getText())
}

function createDescriptorEnvironment(sourceFile: ts.SourceFile): DescriptorEnvironment {
  const imports = new Set<string>()
  const variables = new Map<string, ts.Expression>()
  const functions = new Map<string, ts.FunctionLikeDeclaration>()

  function collect(node: ts.Node) {
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      if (node.importClause.name) imports.add(node.importClause.name.text)
      const bindings = node.importClause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) imports.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) imports.add(element.name.text)
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variables.set(node.name.text, node.initializer)
    }

    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
    ts.forEachChild(node, collect)
  }

  collect(sourceFile)
  return { sourceFile, imports, variables, functions }
}

function isStaticMessageDescriptorExpression(
  expression: ts.Expression,
  environment: DescriptorEnvironment,
  context: ts.Node,
  seen: Set<ts.Node>,
): boolean {
  const current = unwrapExpression(expression)
  if (seen.has(current)) return false
  seen.add(current)

  if (ts.isObjectLiteralExpression(current)) {
    if (objectProperty(current, "id") || objectProperty(current, "message")) return true
    return current.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        isStaticMessageDescriptorExpression(property.expression, environment, context, new Set(seen)),
    )
  }

  if (ts.isIdentifier(current)) {
    if (environment.imports.has(current.text)) return true
    if (isTypedMessageDescriptorParameter(current.text, context)) return true
    const initializer = environment.variables.get(current.text)
    return initializer ? isStaticMessageDescriptorExpression(initializer, environment, context, new Set(seen)) : false
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (isImportedReference(current, environment)) return true
    const resolved = resolvePropertyInitializer(current, environment, seen)
    return resolved ? isStaticMessageDescriptorExpression(resolved, environment, context, new Set(seen)) : false
  }

  if (ts.isCallExpression(current)) {
    const returns = resolveFactoryReturns(current.expression, environment)
    return (
      returns.length > 0 &&
      returns.every((value) => isStaticMessageDescriptorExpression(value, environment, context, new Set(seen)))
    )
  }

  if (ts.isConditionalExpression(current)) {
    return (
      isStaticMessageDescriptorExpression(current.whenTrue, environment, context, new Set(seen)) &&
      isStaticMessageDescriptorExpression(current.whenFalse, environment, context, new Set(seen))
    )
  }

  return false
}

function resolveDescriptorObjects(
  expression: ts.Expression,
  environment: DescriptorEnvironment,
  context: ts.Node,
  seen: Set<ts.Node>,
): ts.ObjectLiteralExpression[] {
  const current = unwrapExpression(expression)
  if (seen.has(current)) return []
  seen.add(current)

  if (ts.isObjectLiteralExpression(current)) {
    if (objectProperty(current, "id") || objectProperty(current, "message")) return [current]
    return current.properties.flatMap((property) =>
      ts.isSpreadAssignment(property)
        ? resolveDescriptorObjects(property.expression, environment, context, new Set(seen))
        : [],
    )
  }

  if (ts.isIdentifier(current)) {
    if (environment.imports.has(current.text) || isTypedMessageDescriptorParameter(current.text, context)) return []
    const initializer = environment.variables.get(current.text)
    return initializer ? resolveDescriptorObjects(initializer, environment, context, new Set(seen)) : []
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (isImportedReference(current, environment)) return []
    const resolved = resolvePropertyInitializer(current, environment, seen)
    return resolved ? resolveDescriptorObjects(resolved, environment, context, new Set(seen)) : []
  }

  if (ts.isCallExpression(current)) {
    return resolveFactoryReturns(current.expression, environment).flatMap((value) =>
      resolveDescriptorObjects(value, environment, context, new Set(seen)),
    )
  }

  if (ts.isConditionalExpression(current)) {
    return [
      ...resolveDescriptorObjects(current.whenTrue, environment, context, new Set(seen)),
      ...resolveDescriptorObjects(current.whenFalse, environment, context, new Set(seen)),
    ]
  }

  return []
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isTypedMessageDescriptorParameter(name: string, context: ts.Node): boolean {
  for (let current: ts.Node | undefined = context; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue
    const parameter = current.parameters.find((item) => ts.isIdentifier(item.name) && item.name.text === name)
    if (!parameter?.type) continue
    return /(?:^|\W)MessageDescriptor(?:\W|$)/.test(parameter.type.getText())
  }
  return false
}

function isImportedReference(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  environment: DescriptorEnvironment,
): boolean {
  let current: ts.Expression = expression.expression
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) && environment.imports.has(current.text)
}

function resolvePropertyInitializer(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  environment: DescriptorEnvironment,
  seen: Set<ts.Node>,
): ts.Expression | undefined {
  const name = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : undefined
  if (!name) return

  const owner = unwrapExpression(expression.expression)
  const container = ts.isIdentifier(owner)
    ? environment.variables.get(owner.text)
    : ts.isPropertyAccessExpression(owner) || ts.isElementAccessExpression(owner)
      ? resolvePropertyInitializer(owner, environment, seen)
      : owner
  if (!container) return

  const value = unwrapExpression(container)
  if (!ts.isObjectLiteralExpression(value)) return
  const property = value.properties.find(
    (item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && propertyName(item.name) === name,
  )
  return property?.initializer
}

function resolveFactoryReturns(
  expression: ts.LeftHandSideExpression,
  environment: DescriptorEnvironment,
): ts.Expression[] {
  if (!ts.isIdentifier(expression)) return []
  const declaration = environment.functions.get(expression.text)
  if (declaration) return functionReturnExpressions(declaration)

  const initializer = environment.variables.get(expression.text)
  const value = initializer && unwrapExpression(initializer)
  if (!value || (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value))) return []
  return functionReturnExpressions(value)
}

function functionReturnExpressions(node: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!node.body) return []
  if (!ts.isBlock(node.body)) return [node.body]
  const returns: ts.Expression[] = []
  function collect(current: ts.Node) {
    if (current !== node.body && ts.isFunctionLike(current)) return
    if (ts.isReturnStatement(current) && current.expression) returns.push(current.expression)
    ts.forEachChild(current, collect)
  }
  collect(node.body)
  return returns
}

function isInsideExcludedJsx(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current)) {
      const name = jsxTagName(current.openingElement.tagName)
      if (EXCLUDED_JSX_ELEMENTS.has(name) || name === "Trans") return true
    }
    if (ts.isJsxSelfClosingElement(current)) {
      const name = jsxTagName(current.tagName)
      if (EXCLUDED_JSX_ELEMENTS.has(name) || name === "Trans") return true
    }
  }
  return false
}

function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  return (
    (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node
  )
}

function isMessageDescriptorProperty(node: ts.PropertyAssignment): boolean {
  const parent = node.parent
  if (!ts.isObjectLiteralExpression(parent)) return false
  const keys = new Set(
    parent.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return []
      const name = propertyName(property.name)
      return name ? [name] : []
    }),
  )
  return keys.has("id") && keys.has("message")
}

function isInsideTestData(node: ts.Node): boolean {
  const sourcePath = normalizePath(node.getSourceFile().fileName)
  return /(?:^|\/)(?:test|testing|__tests__)(?:\/|\.)/.test(sourcePath) || /\.test\.[cm]?[jt]sx?$/.test(sourcePath)
}

function visibleStringLiterals(node: ts.Expression): ts.StringLiteralLike[] {
  if (ts.isStringLiteralLike(node)) return [node]
  if (ts.isParenthesizedExpression(node)) return visibleStringLiterals(node.expression)
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    return visibleStringLiterals(node.expression)
  }
  if (ts.isConditionalExpression(node)) {
    return [...visibleStringLiterals(node.whenTrue), ...visibleStringLiterals(node.whenFalse)]
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...visibleStringLiterals(node.left), ...visibleStringLiterals(node.right)]
  }
  return []
}

function jsxAttribute(
  node: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  name: string,
): { attribute: ts.JsxAttribute; initializer: ts.Expression | undefined } | undefined {
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue
    if (!property.initializer) return { attribute: property, initializer: undefined }
    if (ts.isStringLiteral(property.initializer)) return { attribute: property, initializer: property.initializer }
    if (ts.isJsxExpression(property.initializer))
      return { attribute: property, initializer: property.initializer.expression }
    return { attribute: property, initializer: undefined }
  }
  return
}

function objectProperty(node: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return node.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  )
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return
}

function jsxTagName(name: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(name)) return name.text
  return name.getText()
}

function hasI18nMarker(node: ts.ObjectLiteralExpression, source: string): boolean {
  const prefix = source.slice(Math.max(0, node.getFullStart() - 32), node.getStart())
  return /\/\*\*\s*i18n\s*\*\//.test(prefix)
}

function normalizeLiteral(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return TRANSLATABLE_CHARACTER.test(normalized) ? normalized : ""
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/")
}

function allowlistKey(value: Pick<LocalizationViolation, "path" | "kind" | "literal" | "occurrence">): string {
  return `${normalizePath(value.path)}\u0000${value.kind}\u0000${value.literal}\u0000${value.occurrence}`
}

async function loadAllowlist(filePath: string): Promise<LocalizationAllowlistEntry[]> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return []
  const parsed = JSON.parse(await file.text()) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${filePath}: expected a JSON array`)

  return parsed.map((entry, index) => validateAllowlistEntry(entry, filePath, index))
}

function validateAllowlistEntry(value: unknown, filePath: string, index: number): LocalizationAllowlistEntry {
  if (!value || typeof value !== "object") throw new Error(`${filePath}[${index}]: expected an object`)
  const entry = value as Record<string, unknown>
  const required = ["path", "kind", "literal", "occurrence", "category", "reason"] as const
  for (const key of required) {
    if (entry[key] === undefined) throw new Error(`${filePath}[${index}]: missing ${key}`)
  }
  if (typeof entry.path !== "string" || typeof entry.kind !== "string" || typeof entry.literal !== "string") {
    throw new Error(`${filePath}[${index}]: path, kind, and literal must be strings`)
  }
  if (!Number.isInteger(entry.occurrence) || Number(entry.occurrence) < 1) {
    throw new Error(`${filePath}[${index}]: occurrence must be a positive integer`)
  }
  if (typeof entry.category !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length < 12) {
    throw new Error(`${filePath}[${index}]: category and a specific reason are required`)
  }
  return entry as LocalizationAllowlistEntry
}

async function scanRepository() {
  const strict = process.argv.includes("--strict")
  const json = process.argv.includes("--json")
  const allowlistArg = process.argv.find((argument: string) => argument.startsWith("--allowlist="))
  const allowlistPath = path.resolve(
    REPOSITORY_ROOT,
    allowlistArg?.slice("--allowlist=".length) ?? "script/localization-allowlist.json",
  )
  const allowlist = await loadAllowlist(allowlistPath)
  const violations: LocalizationViolation[] = []
  const glob = new Bun.Glob("**/*.{ts,tsx}")

  for (const relativeRoot of ["packages/app/src", "packages/ui/src"]) {
    const sourceRoot = path.join(REPOSITORY_ROOT, relativeRoot)
    for await (const relativePath of glob.scan({ cwd: sourceRoot })) {
      if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".test.tsx")) continue
      if (relativePath.includes("/testing/") || relativePath.startsWith("testing/")) continue
      const projectPath = normalizePath(path.join(relativeRoot, relativePath))
      const source = await readFile(path.join(sourceRoot, relativePath), "utf8")
      violations.push(...analyzeLocalizationSource(projectPath, source))
    }
  }

  const remaining = applyLocalizationAllowlist(violations, allowlist).toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  )

  if (json) {
    console.log(JSON.stringify(remaining, null, 2))
  } else if (remaining.length === 0) {
    console.log("Localization contract passed with no unclassified violations.")
  } else {
    for (const violation of remaining) {
      console.error(
        `${violation.path}:${violation.line}:${violation.column} [${violation.kind}] ${JSON.stringify(violation.literal)} (occurrence ${violation.occurrence})`,
      )
    }
    console.error(`Localization contract found ${remaining.length} unclassified violation(s).`)
  }

  if (strict && remaining.length > 0) process.exit(1)
}

if (import.meta.main) await scanRepository()
