import { execFileSync } from "node:child_process"
import path from "node:path"
import ts from "typescript"
import { revisionFiles } from "./catalog"
import { imports } from "../workspace-dependencies"
import type { Task, TaskInputs, WorkspaceInput } from "./plan"

export async function taskInputs(root: string, revision: string, tasks: Task[], workspaces: WorkspaceInput[]) {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
  const inventory = new Set(files)
  const source = revisionFiles(
    root,
    revision,
    files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)(?:tsconfig|package)\.json$/.test(file)),
  )
  const read = (file: string) => source.get(file) ?? ""
  const owner = (file: string) => workspaces.find((entry) => file.startsWith(entry.directory + "/"))
  const aliases = new Map<string, { complete: boolean; source: boolean }>()
  for (const workspace of workspaces) {
    const file = `${workspace.directory}/tsconfig.json`
    if (!inventory.has(file)) {
      aliases.set(workspace.directory, { complete: true, source: false })
      continue
    }
    const parsed = ts.parseConfigFileTextToJson(file, read(file))
    const config = parsed.config as
      | { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
      | undefined
    const paths = config?.compilerOptions?.paths ?? {}
    const source = paths["@/*"]?.length === 1 && ["./src/*", "src/*"].includes(paths["@/*"][0]!)
    aliases.set(workspace.directory, {
      complete:
        !parsed.error &&
        !!config &&
        (!config.extends || config.extends === "@tsconfig/bun/tsconfig.json") &&
        (!config.compilerOptions?.baseUrl || config.compilerOptions.baseUrl === ".") &&
        Object.keys(paths).every((key) => key === "@/*" && source),
      source,
    })
  }
  const resolve = (file: string) => {
    const stem = file.replace(/\.[cm]?jsx?$/, "")
    return [
      file,
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"].map(
        (ext) => stem + ext,
      ),
    ].find((candidate) => inventory.has(candidate))
  }
  const exportTargets = (value: unknown): string[] => {
    if (typeof value === "string") return [value]
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const conditions = value as Record<string, unknown>
    if ("bun" in conditions) return exportTargets(conditions.bun)
    return Object.entries(conditions)
      .filter(([condition]) => condition !== "types")
      .flatMap(([, target]) => exportTargets(target))
  }
  const publicInputs = (workspace: WorkspaceInput, specifier: string) => {
    const manifest = JSON.parse(read(`${workspace.directory}/package.json`) || "{}") as {
      exports?: unknown
      main?: string
    }
    const key = "." + specifier.slice(workspace.name.length)
    if (!manifest.exports)
      return [resolve(path.posix.join(workspace.directory, key === "." ? (manifest.main ?? "index") : key))]
    const entries =
      typeof manifest.exports === "object" && manifest.exports !== null
        ? (manifest.exports as Record<string, unknown>)
        : undefined
    let targets = exportTargets(
      entries?.[key] ??
        (key === "." && (!entries || !Object.keys(entries).some((entry) => entry.startsWith(".")))
          ? manifest.exports
          : undefined),
    )
    if (!targets.length && entries) {
      for (const [pattern, value] of Object.entries(entries)) {
        const [prefix, suffix] = pattern.split("*")
        if (suffix === undefined || !key.startsWith(prefix!) || !key.endsWith(suffix)) continue
        const captured = key.slice(prefix!.length, suffix ? -suffix.length : undefined)
        targets = exportTargets(value).map((target) => target.replaceAll("*", captured))
        break
      }
    }
    return targets.map((target) =>
      target.startsWith("./") ? resolve(path.posix.join(workspace.directory, target)) : undefined,
    )
  }
  const analyses = new Map<string, { complete: boolean; specifiers: string[] }>()
  const analyze = (file: string) => {
    const existing = analyses.get(file)
    if (existing) return existing
    const workspace = owner(file)
    const result = {
      complete: !workspace || aliases.get(workspace.directory)?.complete !== false,
      specifiers: imports(file, read(file)),
    }
    const syntax = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ["require", "import.meta.resolve"].includes(node.expression.getText(syntax))) &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      )
        result.complete = false
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(syntax) === "URL" &&
        node.arguments?.[1]?.getText(syntax) === "import.meta.url" &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      )
        result.complete = false
      ts.forEachChild(node, inspect)
    }
    inspect(syntax)
    analyses.set(file, result)
    return result
  }
  const results: Record<string, TaskInputs> = {}
  for (const task of tasks.filter((task) => task.inputs)) {
    const visited = new Set<string>()
    const packages = new Set<string>()
    const roots = new Set(
      task.inputs!.map((file) => owner(file)?.directory).filter((directory): directory is string => !!directory),
    )
    let complete = true
    const addPackage = (name: string) => {
      const entry = workspaces.find((item) => item.name === name)
      if (!entry || packages.has(entry.directory)) return
      packages.add(entry.directory)
      for (const dependency of [...entry.dependencies, ...entry.testDependencies]) addPackage(dependency)
    }
    const visit = (file: string) => {
      if (visited.has(file)) return
      visited.add(file)
      if (!inventory.has(file)) {
        complete = false
        return
      }
      if (!/\.[cm]?[jt]sx?$/.test(file)) return
      const fileOwner = owner(file)
      const alias = fileOwner && aliases.get(fileOwner.directory)
      const analysis = analyze(file)
      if (!analysis.complete) complete = false
      for (const specifier of analysis.specifiers) {
        const local = specifier.startsWith(".")
          ? path.posix.join(path.posix.dirname(file), specifier)
          : specifier.startsWith("@/") && fileOwner && alias?.source
            ? path.posix.join(fileOwner.directory, "src", specifier.slice(2))
            : undefined
        if (local) {
          const target = resolve(path.posix.normalize(local))
          if (!target) {
            complete = false
            continue
          }
          const targetOwner = owner(target)
          if (targetOwner && !roots.has(targetOwner.directory)) addPackage(targetOwner.name)
          visit(target)
          continue
        }
        if (specifier.startsWith("#") || specifier.startsWith("@/")) {
          complete = false
          continue
        }
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
        const dependency = workspaces.find((entry) => entry.name === name)
        if (dependency) {
          addPackage(dependency.name)
          const targets = publicInputs(dependency, specifier)
          if (!targets.length || targets.some((target) => !target)) complete = false
          for (const target of targets) if (target) visit(target)
        }
      }
    }
    for (const file of task.inputs!) visit(file)
    for (const directory of roots)
      for (const file of files.filter(
        (file) =>
          file.startsWith(directory + "/") && /\/(?:src|test|script)\//.test(file) && !/\.[cm]?[jt]sx?$/.test(file),
      ))
        visited.add(file)
    results[task.id] = { files: [...visited].sort(), packages: [...packages].sort(), complete }
  }
  return results
}
