import ts from "@typescript/typescript6"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { RevisionSnapshot } from "./ci/revision"
import { WorkingSnapshot } from "./verification"
import { workspaces } from "./workspace-manifest"
import { splitBatchFiles } from "../packages/testing/script/batches"
import { testOptions as webOptions } from "../apps/web/script/test-options"
import { testOptions as uiOptions } from "../packages/ui/script/test-options"

function inspect(file: string, source: string) {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const bindings = new Map<string, string>()
  for (const node of syntax.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "bun:test"
    )
      continue
    const named = node.importClause?.namedBindings
    if (named && ts.isNamedImports(named))
      for (const entry of named.elements) bindings.set(entry.name.text, entry.propertyName?.text ?? entry.name.text)
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, "*")
  }
  const only: number[] = [],
    mocks: number[] = [],
    retries: number[] = [],
    sleeps: number[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const chain = node.expression.getText(syntax).split(".")
      const binding = bindings.get(chain[0]!)
      const parts = binding === "*" ? chain.slice(1) : binding ? [binding, ...chain.slice(1)] : []
      const line = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1
      if (["test", "it", "describe"].includes(parts[0] ?? "") && parts.includes("only")) only.push(line)
      if (parts.join(".") === "mock.module") mocks.push(line)
      if (
        ["test", "it"].includes(parts[0] ?? "") &&
        node.arguments.some(
          (arg) =>
            ts.isObjectLiteralExpression(arg) &&
            arg.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) && property.name.getText(syntax).replaceAll(/['"]/g, "") === "retry",
            ),
        )
      )
        retries.push(line)
      if (
        ["Bun.sleep", "page.waitForTimeout"].includes(chain.join(".")) &&
        node.arguments[0] &&
        ts.isNumericLiteral(node.arguments[0])
      )
        sleeps.push(line)
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  return { only, mocks, retries, sleeps }
}

export function testPolicy(file: string, source: string, isolated: boolean, previous: string) {
  const current = inspect(file, source),
    before = inspect(file, previous)
  const errors = current.only.map((line) => `${file}:${line}: focused tests cannot enter CI`)
  if (current.retries.length > before.retries.length)
    errors.push(`${file}: new test retries hide failures; repair the invariant`)
  if (!isolated && current.mocks.length > before.mocks.length)
    errors.push(`${file}: new mock.module needs a dedicated process; prefer a scoped spy`)
  const warnings = [
    ...(!isolated && current.mocks.length ? [`${file}: existing unisolated module replacement needs review`] : []),
    ...current.sleeps.map(
      (line) => `${file}:${line}: fixed sleep; use an observable barrier unless elapsed time is the behavior`,
    ),
  ]
  return { errors, warnings }
}

export async function checkTestPolicy(root: string, base?: string) {
  const snapshot = new WorkingSnapshot(root)
  const packages = workspaces(root)
  const revision =
    base ?? execFileSync("git", ["merge-base", "HEAD", "origin/dev"], { cwd: root, encoding: "utf8" }).trim()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Test policy needs an exact base revision")
  const before = new RevisionSnapshot(root, revision)
  const errors: string[] = [],
    warnings: string[] = []
  const files = snapshot.files.filter((file) => /(?:^|\/)test\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
  const isolated = new Set<string>()
  for (const pkg of packages) {
    const owned = files
      .filter((file) => file.startsWith(pkg.directory + "/"))
      .map((file) => file.slice(pkg.directory.length + 1))
    const options = pkg.directory === "apps/web" ? webOptions : pkg.directory === "packages/ui" ? uiOptions : undefined
    const serial = options
      ? [...options.isolated, ...(options.extraSerial ?? [])]
      : splitBatchFiles(owned, path.join(root, pkg.directory)).isolated
    for (const file of serial) isolated.add(`${pkg.directory}/${file}`)
  }
  for (const file of files) {
    const previous = before.read(file) ?? ""
    const result = testPolicy(file, snapshot.required(file), isolated.has(file) || file.startsWith("test/"), previous)
    errors.push(...result.errors)
    if (snapshot.required(file) !== previous) warnings.push(...result.warnings)
  }
  for (const warning of warnings.slice(0, 20)) console.warn(warning)
  if (warnings.length)
    console.warn(`Test policy: ${warnings.length} advisory findings; repair affected fixtures as they change`)
  for (const error of errors) console.error(error)
  return errors.length === 0
}

if (import.meta.main && !(await checkTestPolicy(path.resolve(import.meta.dir, ".."), process.argv[2])))
  process.exitCode = 1
