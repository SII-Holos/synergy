import { execFileSync } from "node:child_process"
import path from "node:path"
import ts from "typescript"
import { revisionFiles } from "./catalog"
import { coverageChanges } from "./coverage-selection"
import type { WorkspaceInput } from "./plan"
import type { SelectionChanges } from "./selection"
import { imports } from "../workspace-dependencies"

function parse(source: string | undefined): unknown {
  try {
    return source === undefined ? undefined : JSON.parse(source)
  } catch {
    return undefined
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function targets(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(targets)
  return record(value) ? Object.values(value).flatMap(targets) : []
}

function leafTests(root: string, revision: string, candidates: string[], workspaces: WorkspaceInput[]) {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
  const inventory = new Set(files)
  const source = revisionFiles(
    root,
    revision,
    files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(file)),
  )
  const owner = (file: string) => workspaces.find((entry) => file.startsWith(entry.directory + "/"))
  const manifests = new Map(
    workspaces.map((entry) => [entry.name, parse(source.get(`${entry.directory}/package.json`))]),
  )
  const aliases = new Map<string, boolean>()
  function knownAliases(file: string, active = new Set<string>()): boolean {
    if (aliases.has(file)) return aliases.get(file)!
    if (active.has(file) || !source.has(file)) return false
    active.add(file)
    const parsed = ts.parseConfigFileTextToJson(file, source.get(file)!)
    const config: unknown = parsed.config
    if (parsed.error || !record(config)) return false
    if (config.extends && config.extends !== "@tsconfig/bun/tsconfig.json") {
      if (typeof config.extends !== "string" || !config.extends.startsWith(".")) return false
      const parent = path.posix.normalize(path.posix.join(path.posix.dirname(file), config.extends))
      if (!knownAliases(parent.endsWith(".json") ? parent : `${parent}.json`, active)) return false
    }
    const options = config.compilerOptions
    if (options !== undefined && !record(options)) return false
    if (record(options)) {
      if (options.baseUrl !== undefined && options.baseUrl !== ".") return false
      if (options.paths !== undefined && !record(options.paths)) return false
      if (
        record(options.paths) &&
        Object.entries(options.paths).some(
          ([key, value]) =>
            key !== "@/*" || !Array.isArray(value) || value.length !== 1 || !["./src/*", "src/*"].includes(value[0]),
        )
      )
        return false
    }
    aliases.set(file, true)
    active.delete(file)
    return true
  }
  const eligible = new Set(candidates)
  const stem = (file: string) => file.replace(/\.[cm]?[jt]sx?$/, "")
  const testNames = candidates.map((file) => path.posix.basename(stem(file)))
  const candidateFor = (file: string) => candidates.filter((candidate) => stem(candidate) === stem(file))
  const consumers = new Map(candidates.map((file) => [file, new Set([owner(file)?.name])]))
  for (const names of consumers.values()) {
    for (;;) {
      const before = names.size
      for (const entry of workspaces)
        if ([...entry.dependencies, ...entry.testDependencies].some((name) => names.has(name))) names.add(entry.name)
      if (names.size === before) break
    }
  }
  for (const candidate of candidates) {
    const entry = owner(candidate)
    const manifest = entry && manifests.get(entry.name)
    if (!entry || !record(manifest)) {
      eligible.delete(candidate)
      continue
    }
    for (const target of targets(manifest.exports ?? manifest.main)) {
      if (
        (!target.startsWith("./") && manifest.exports !== undefined) ||
        new Bun.Glob(target.replace(/^\.\//, "")).match(candidate.slice(entry.directory.length + 1))
      )
        eligible.delete(candidate)
    }
  }
  for (const [file, content] of source) {
    if (!eligible.size) break
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const entry = owner(file)
    if (
      !eligible.has(file) &&
      !testNames.some((name) => content.includes(name)) &&
      !candidates.some((candidate) => consumers.get(candidate)?.has(entry?.name))
    )
      continue
    const syntax = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const config = entry && `${entry.directory}/tsconfig.json`
    let unresolved = !!config && source.has(config) && !knownAliases(config)
    const inspect = (node: ts.Node) => {
      if (
        eligible.has(file) &&
        (ts.isExportDeclaration(node) ||
          ts.isExportAssignment(node) ||
          (ts.canHaveModifiers(node) &&
            ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)))
      )
        eligible.delete(file)
      if (ts.isStringLiteralLike(node)) {
        for (const target of [node.text, path.posix.normalize(path.posix.join(path.posix.dirname(file), node.text))])
          for (const candidate of candidateFor(target)) if (candidate !== file) eligible.delete(candidate)
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ["require", "import.meta.resolve", "Bun.file", "readFile", "readFileSync"].includes(
            node.expression.getText(syntax),
          )) &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      )
        unresolved = true
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(syntax) === "URL" &&
        node.arguments?.[1]?.getText(syntax) === "import.meta.url" &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      )
        unresolved = true
      ts.forEachChild(node, inspect)
    }
    inspect(syntax)
    for (const specifier of imports(file, content)) {
      if (specifier.startsWith(".")) continue
      const dependency = workspaces.find(
        (workspace) => specifier === workspace.name || specifier.startsWith(workspace.name + "/"),
      )
      if (!dependency) {
        if (specifier.startsWith("#") || (specifier.startsWith("@/") && (!config || !knownAliases(config))))
          unresolved = true
        continue
      }
      const manifest = manifests.get(dependency.name)
      const subpath = "." + specifier.slice(dependency.name.length)
      if (!record(manifest) || !manifest.exports) {
        const target =
          subpath === "." && record(manifest) && typeof manifest.main === "string" ? manifest.main : subpath
        for (const candidate of candidateFor(path.posix.join(dependency.directory, target))) eligible.delete(candidate)
        continue
      }
      const exports = record(manifest.exports) ? manifest.exports : { ".": manifest.exports }
      for (const [key, value] of Object.entries(exports)) {
        const [prefix, suffix] = key.split("*")
        if (key !== subpath && (suffix === undefined || !subpath.startsWith(prefix!) || !subpath.endsWith(suffix)))
          continue
        const capture = suffix === undefined ? "" : subpath.slice(prefix!.length, suffix ? -suffix.length : undefined)
        for (const target of targets(value))
          for (const candidate of candidateFor(path.posix.join(dependency.directory, target.replaceAll("*", capture))))
            eligible.delete(candidate)
      }
    }
    if (unresolved && entry)
      for (const candidate of candidates)
        if (candidate !== file && consumers.get(candidate)?.has(entry.name)) eligible.delete(candidate)
  }
  return { eligible, inventory }
}

export async function selectionInputs(
  root: string,
  base: string,
  head: string,
  changed: string[],
  baseWorkspaces: WorkspaceInput[],
  headWorkspaces: WorkspaceInput[],
): Promise<SelectionChanges> {
  const result: SelectionChanges = { leafTests: [] }
  if (changed.includes("script/coverage-exempt.json")) {
    const file = "script/coverage-exempt.json"
    result.coverage = coverageChanges(
      parse(revisionFiles(root, base, [file]).get(file)),
      parse(revisionFiles(root, head, [file]).get(file)),
      baseWorkspaces,
      headWorkspaces,
    )
  }
  const candidates = changed.filter(
    (file) =>
      /\/test\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !/\/(?:support|fixtures?)\//.test(file) &&
      !file.startsWith("packages/testing/") &&
      baseWorkspaces.some(
        (entry) =>
          file.startsWith(entry.directory + "/") &&
          headWorkspaces.some((other) => other.name === entry.name && other.directory === entry.directory),
      ),
  )
  if (!candidates.length) return result
  const before = leafTests(root, base, candidates, baseWorkspaces)
  const after = base === head ? before : leafTests(root, head, candidates, headWorkspaces)
  result.leafTests = candidates
    .filter(
      (file) =>
        (before.inventory.has(file) || after.inventory.has(file)) &&
        before.eligible.has(file) &&
        after.eligible.has(file),
    )
    .sort()
  return result
}
