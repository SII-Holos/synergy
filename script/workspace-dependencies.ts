import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

export interface Workspace {
  directory: string
  name: string
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export function workspaces(root: string): Workspace[] {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  return manifest.workspaces.packages.map((directory: string) => ({
    ...JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")),
    directory,
  }))
}

export function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "target", ".git", ".turbo"].includes(entry.name)) return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : []
  })
}

export function imports(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const result = new Set<string>()
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent
      if (
        (ts.isModuleDeclaration(parent) && parent.name === node) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isNewExpression(parent) &&
          parent.expression.getText(syntax) === "URL" &&
          parent.arguments?.[0] === node &&
          parent.arguments?.[1]?.getText(syntax) === "import.meta.url") ||
        (ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ["require", "import.meta.resolve"].includes(parent.expression.getText(syntax))))
      ) {
        result.add(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  return [...result]
}

export function cycles(edges: Record<string, string[]>): string[][] {
  const active = new Set<string>()
  const completed = new Set<string>()
  const stack: string[] = []
  const found = new Map<string, string[]>()
  function visit(node: string) {
    if (active.has(node)) {
      const cycle = stack.slice(stack.indexOf(node))
      const key = [...cycle].sort().join("\0")
      found.set(key, [...cycle, node])
      return
    }
    if (completed.has(node)) return
    active.add(node)
    stack.push(node)
    for (const next of edges[node] ?? []) visit(next)
    stack.pop()
    active.delete(node)
    completed.add(node)
  }
  for (const node of Object.keys(edges)) visit(node)
  return [...found.values()]
}

export function workspaceGraph(packages: Workspace[]) {
  const names = new Set(packages.map((pkg) => pkg.name))
  return Object.fromEntries(
    packages.map((pkg) => [
      pkg.name,
      Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter((name) =>
        names.has(name),
      ),
    ]),
  )
}

export function validateWorkspaces(root: string) {
  const packages = workspaces(root)
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const owner = (file: string) => packages.find((pkg) => file.startsWith(path.resolve(root, pkg.directory) + path.sep))
  const failures: string[] = []
  const graph = workspaceGraph(packages)
  const rules: Record<string, string[]> = JSON.parse(
    readFileSync(path.join(root, "script/dependency-rules.json"), "utf8"),
  )
  for (const pkg of packages) {
    const allowed = rules[pkg.directory]
    if (allowed)
      for (const target of graph[pkg.name]) {
        if (!allowed.includes(byName.get(target)!.directory))
          failures.push(`${pkg.directory}: forbidden dependency ${target}`)
      }
    if (pkg.directory.startsWith("packages/"))
      for (const target of graph[pkg.name]) {
        if (byName.get(target)!.directory.startsWith("apps/"))
          failures.push(`${pkg.directory}: library imports application ${target}`)
      }
    if (pkg.dependencies?.["@ericsanchezok/synergy-testing"])
      failures.push(`${pkg.directory}: testing must be a development dependency`)
    for (const file of sourceFiles(path.join(root, pkg.directory, "src"))) {
      for (const spec of imports(file, readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) {
          const target = owner(path.resolve(path.dirname(file), spec))
          if (target && target !== pkg)
            failures.push(`${path.relative(root, file)}: private cross-package import ${spec}`)
          continue
        }
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!
        const target = byName.get(name)
        if (!target) continue
        if (target !== pkg && !graph[pkg.name].includes(name))
          failures.push(`${path.relative(root, file)}: undeclared production dependency ${name}`)
        const subpath = spec === name ? "." : `.${spec.slice(name.length)}`
        if (subpath.startsWith("./test/"))
          failures.push(`${path.relative(root, file)}: production source imports testing-only export ${spec}`)
        const entries = Object.keys(target.exports ?? {})
        const declared = entries.some(
          (entry) =>
            entry === subpath ||
            (entry.includes("*") && subpath.startsWith(entry.split("*")[0]!) && subpath.endsWith(entry.split("*")[1]!)),
        )
        if (!declared) failures.push(`${path.relative(root, file)}: undeclared export ${spec}`)
      }
    }
  }
  for (const cycle of cycles(graph)) failures.push(`Production dependency cycle: ${cycle.join(" -> ")}`)
  return { packages, graph, failures }
}

if (import.meta.main) {
  const result = validateWorkspaces(path.resolve(import.meta.dir, ".."))
  for (const failure of result.failures) console.error(failure)
  console.log(`${result.packages.length} workspaces; ${result.failures.length} dependency violations`)
  if (result.failures.length) process.exitCode = 1
}
