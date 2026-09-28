import { execFileSync } from "node:child_process"
import type { Task, WorkspaceInput, TaskInputs } from "./plan"

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
  return /^(README(?:\.[a-zA-Z-]+)?\.md|CONTRIBUTING\.md|LICENSE(?:\.md)?|docs\/.*\.md|\.synergy\/skill\/[^/]+\/(?:SKILL\.md|agents\/openai\.yaml))$/.test(
    file,
  )
}

export function selectAffected(
  changed: string[],
  base: WorkspaceInput[],
  head: WorkspaceInput[],
  knownTests: string[] = [],
) {
  const documentationOnly = changed.length > 0 && changed.every(documentation)
  const all = [...base, ...head]
  const names = new Set<string>()
  let full = false
  for (const file of changed) {
    if (documentation(file) || knownTests.includes(file)) continue
    if (/^(?:\.github\/|\.synergy\/|script\/|test\/|patches\/|packages\/testing\/)/.test(file)) full = true
    const owners = all.filter((entry) => file.startsWith(entry.directory + "/"))
    if (!owners.length) full = true
    for (const entry of owners) {
      names.add(entry.name)
      if (/\/(?:package\.json|bunfig\.toml|tsconfig[^/]*\.json)$/.test(file)) full = true
    }
  }
  for (;;) {
    const before = names.size
    for (const entry of all) {
      if ([...entry.dependencies, ...entry.testDependencies].some((name) => names.has(name))) names.add(entry.name)
    }
    if (before === names.size) break
  }
  return {
    full,
    documentationOnly,
    packages: [...new Set(all.filter((entry) => full || names.has(entry.name)).map((entry) => entry.directory))].sort(),
  }
}

export function taskSelected(
  task: Task,
  packages: Set<string>,
  changed: string[],
  docs: boolean,
  base?: TaskInputs,
  head?: TaskInputs,
): boolean {
  if (task.kind === "policy") return true
  if (docs) return false
  if (["static", "typecheck"].includes(task.kind)) return true
  const adapterFiles: Record<string, string> = {
    "benchmark/runtime/capture-pi.mjs": "pi",
    "benchmark/runtime/capture-plugin.mjs": "opencode",
  }
  const code = changed.filter((file) => !documentation(file))
  if (code.length && code.every((file) => adapterFiles[file])) {
    return (
      task.kind === "benchmark-pure" ||
      (task.kind === "benchmark-native" && code.some((file) => adapterFiles[file] === task.variant))
    )
  }
  if (task.inputs) {
    if (!base?.complete || !head?.complete) return code.length > 0
    return code.some(
      (file) =>
        [...base.files, ...head.files].includes(file) ||
        [...base.packages, ...head.packages].some((owner) => file.startsWith(owner + "/")),
    )
  }
  if (code.some((file) => task.files?.includes(file))) return true
  if (code.length && code.every((file) => /^benchmark\/configs\/[^/]+\.yaml$/.test(file)))
    return task.kind === "benchmark-pure"
  if (task.owners.some((owner) => packages.has(owner))) return true
  const storage = changed.some((file) =>
    /^packages\/harness\/(?:src|test)\/(?:storage|migration|session|execution|permission|lifecycle)\//.test(file),
  )
  if (storage && ["postgres", "rollout", "artifacts", "smoke", "sandbox", "benchmark-docker"].includes(task.kind))
    return true
  const local = packages.has("packages/local-runtime")
  if (local && ["windows", "sandbox", "artifacts", "benchmark-docker"].includes(task.kind)) return true
  if (packages.has("apps/web") && ["web", "desktop"].includes(task.kind)) return true
  const benchmark = changed.some((file) => file.startsWith("benchmark/"))
  if (task.kind.startsWith("benchmark-") && benchmark) return true
  if (task.kind === "benchmark-native") return task.variant === "synergy" && packages.has("packages/harness")
  return false
}
