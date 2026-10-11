import { execFileSync } from "node:child_process"
import type { Task, WorkspaceInput, TaskInputs } from "./plan"

export interface CoverageChanges {
  complete: boolean
  packages: string[]
  files: string[]
}

export interface SelectionChanges {
  coverage?: CoverageChanges
  leafTests?: string[]
  metadataOnly?: string[]
}

export interface FullTrigger {
  file: string
  reason: "shared-input" | "unknown-owner" | "workspace-configuration"
}

const generatedOwners: Record<string, string[]> = {
  "packages/sdk/openapi.json": ["packages/sdk/js", "packages/server"],
}

export interface SelectionContext extends SelectionChanges {
  runtimePackages?: string[]
}

export function changedFiles(root: string, base: string, head: string): string[] {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("CI requires exact base and head revisions")
  // Base-only updates are not PR changes; retain both paths of a rename for ownership analysis.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .split("\0")
    .filter(Boolean)
    .sort()
}

export function documentation(file: string): boolean {
  return /^(README(?:\.[a-zA-Z-]+)?\.md|CONTRIBUTING\.md|LICENSE(?:\.md)?|docs\/.*\.md|\.synergy\/skill\/[^/]+\/(?:SKILL\.md|references\/.*\.md|agents\/openai\.yaml))$/.test(
    file,
  )
}

export function selectAffected(
  changed: string[],
  base: WorkspaceInput[],
  head: WorkspaceInput[],
  knownTests: string[] = [],
  changes: SelectionChanges = {},
) {
  const documentationOnly = changed.length > 0 && changed.every(documentation)
  const all = [...base, ...head]
  const names = new Set<string>()
  const testOwners = new Set<string>()
  const fullTriggers: FullTrigger[] = []
  for (const file of changed) {
    if (documentation(file) || knownTests.includes(file)) continue
    if (file === "script/coverage-exempt.json" && changes.coverage?.complete) {
      for (const directory of changes.coverage.packages) {
        const owners = all.filter((entry) => entry.directory === directory)
        if (!owners.length) fullTriggers.push({ file, reason: "unknown-owner" })
        for (const entry of owners) names.add(entry.name)
      }
      continue
    }
    const generated = generatedOwners[file]
    if (
      generated?.every((directory) =>
        [base, head].every((entries) => entries.some((entry) => entry.directory === directory)),
      )
    ) {
      for (const entry of all) if (generated.includes(entry.directory)) names.add(entry.name)
      continue
    }
    const shared = /^(?:\.github\/|\.synergy\/|script\/|test\/|patches\/|packages\/testing\/)/.test(file)
    if (shared) fullTriggers.push({ file, reason: "shared-input" })
    const owners = all.filter((entry) => file.startsWith(entry.directory + "/"))
    if (!owners.length && !shared) fullTriggers.push({ file, reason: "unknown-owner" })
    for (const entry of owners) {
      if (changes.leafTests?.includes(file)) testOwners.add(entry.name)
      else names.add(entry.name)
    }
    if (
      owners.length &&
      !shared &&
      /\/(?:package\.json|bunfig\.toml|tsconfig[^/]*\.json)$/.test(file) &&
      !changes.metadataOnly?.includes(file)
    )
      fullTriggers.push({ file, reason: "workspace-configuration" })
  }
  for (;;) {
    const before = names.size
    for (const entry of all) {
      if ([...entry.dependencies, ...entry.testDependencies].some((name) => names.has(name))) names.add(entry.name)
    }
    if (before === names.size) break
  }
  const full = fullTriggers.length > 0
  return {
    full,
    fullTriggers,
    documentationOnly,
    packages: [
      ...new Set(
        all
          .filter((entry) => full || names.has(entry.name) || testOwners.has(entry.name))
          .map((entry) => entry.directory),
      ),
    ].sort(),
    runtimePackages: [
      ...new Set(all.filter((entry) => full || names.has(entry.name)).map((entry) => entry.directory)),
    ].sort(),
  }
}

export function taskSelected(
  task: Task,
  packages: Set<string>,
  changed: string[],
  docs: boolean,
  base?: TaskInputs,
  head?: TaskInputs,
  context: SelectionContext = {},
): boolean {
  if (task.kind === "policy") return true
  if (docs) return false
  if (["static", "typecheck"].includes(task.kind)) return true
  if (task.kind === "suite" && task.owners.some((owner) => packages.has(owner))) return true
  const adapterFiles: Record<string, string> = {
    "benchmark/runtime/capture-pi.mjs": "pi",
    "benchmark/runtime/capture-plugin.mjs": "opencode",
  }
  const original = changed.filter((file) => !documentation(file))
  if (original.some((file) => task.files?.includes(file) || task.inputs?.includes(file))) return true
  if (
    ["windows", "macos"].includes(task.pool) &&
    original.some((file) => task.owners.some((owner) => file.startsWith(`${owner}/test/`)))
  )
    return true
  const code = original.flatMap((file) =>
    context.leafTests?.includes(file)
      ? []
      : file === "script/coverage-exempt.json" && context.coverage?.complete
        ? context.coverage.files
        : [file],
  )
  const runtime = context.runtimePackages ? new Set(context.runtimePackages) : packages
  if (code.some((file) => generatedOwners[file]?.some((owner) => task.owners.includes(owner)))) return true
  if (task.kind === "benchmark-native") {
    const benchmark = code.filter((file) => file.startsWith("benchmark/"))
    if (benchmark.some((file) => !adapterFiles[file] && !/^benchmark\/configs\/[^/]+\.yaml$/.test(file))) return true
    if (benchmark.some((file) => adapterFiles[file] === task.variant)) return true
    return (
      task.variant === "synergy" && (runtime.has("packages/harness") || task.owners.some((owner) => runtime.has(owner)))
    )
  }
  if (task.id === "benchmark-docker-pi-compaction" && code.includes("benchmark/runtime/capture-pi.mjs")) return true
  if (code.length && code.every((file) => adapterFiles[file])) return task.kind === "benchmark-pure"
  if (task.inputs) {
    if (!base?.complete || !head?.complete) return code.length > 0
    return code.some(
      (file) =>
        [...base.files, ...head.files].includes(file) ||
        [...base.packages, ...head.packages].some((owner) => file.startsWith(owner + "/")),
    )
  }
  if (code.length && code.every((file) => /^benchmark\/configs\/[^/]+\.yaml$/.test(file)))
    return task.kind === "benchmark-pure"
  if (task.owners.some((owner) => (task.kind === "suite" ? packages : runtime).has(owner))) return true
  const storage = code.some((file) =>
    /^packages\/harness\/(?:src|test)\/(?:storage|migration|session|execution|permission|lifecycle)\//.test(file),
  )
  if (storage && ["postgres", "rollout", "artifacts", "smoke", "sandbox", "benchmark-docker"].includes(task.kind))
    return true
  const local = runtime.has("packages/local-runtime")
  if (local && ["windows", "sandbox", "artifacts", "benchmark-docker"].includes(task.kind)) return true
  if (runtime.has("apps/web") && ["web", "desktop"].includes(task.kind)) return true
  const benchmark = code.some((file) => file.startsWith("benchmark/"))
  if (task.kind.startsWith("benchmark-") && benchmark) return true
  return false
}
