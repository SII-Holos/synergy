import path from "node:path"
import ts from "typescript"
import type { SourceSnapshot } from "./revision"
import type { Task, TaskInputs, WorkspaceInput } from "./plan"
export { selectionInputs } from "./selection-inputs"

export async function taskInputs(snapshot: SourceSnapshot, tasks: Task[], workspaces: WorkspaceInput[]) {
  const { files, inventory } = snapshot
  const read = (file: string) => snapshot.required(file)
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
    ].find((candidate) => inventory.get(candidate)?.type === "blob")
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
    const manifest = JSON.parse(read(`${workspace.directory}/package.json`)) as {
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
  const analyze = (file: string) => {
    const workspace = owner(file)
    const facts = snapshot.facts(file)
    return {
      complete: (!workspace || aliases.get(workspace.directory)?.complete !== false) && !facts.dynamicReferences,
      specifiers: facts.specifiers,
    }
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
      if (inventory.get(file)?.type !== "blob") {
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
