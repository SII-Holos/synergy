import { createHash } from "node:crypto"

export type Pool = "linux" | "docker" | "postgres" | "windows" | "macos"
export type Mode = "full" | "shadow" | "affected" | "diagnostic"
export type TaskKind =
  | "policy"
  | "static"
  | "typecheck"
  | "suite"
  | "packages"
  | "artifacts"
  | "web"
  | "desktop"
  | "smoke"
  | "windows"
  | "native-workspace"
  | "postgres"
  | "benchmark-pure"
  | "benchmark-streams"
  | "benchmark-prepare"
  | "benchmark-docker"
  | "benchmark-native"
  | "rollout"
  | "sandbox"

export interface WorkspaceInput {
  directory: string
  name: string
  dependencies: string[]
  testDependencies: string[]
}

export interface Task {
  id: string
  kind: TaskKind
  pool: Pool
  owners: string[]
  needs: string[]
  seconds: number
  package?: string
  partition?: number
  variant?: string
  files?: string[]
  assets?: string[]
  prerequisites?: Array<"browser" | "desktop" | "sandbox">
  diagnosticFiles?: string[]
  outputs?: Array<"junit" | "lcov" | "timing">
  isolation?: "batch-home" | "task-home" | "container" | "database"
}

export interface Unit {
  id: string
  pool: Pool
  tasks: string[]
  seconds: number
  browser: boolean
  desktop: boolean
  sandbox: boolean
  build: boolean
  policy: boolean
}

export interface Plan {
  version: 1
  base: string
  head: string
  sha: string
  run: string
  attempt: string
  mode: Mode
  changed: string[]
  selected: string[]
  proposed: string[]
  reasons: Record<string, string>
  tasks: Task[]
  units: Unit[]
  digest: string
}

export const LIMITS: Record<Pool, number> = { linux: 6, docker: 3, postgres: 2, windows: 1, macos: 1 }
export const QUEUES = [
  "contracts",
  "linux",
  "docker-external",
  "docker-ready",
  "docker",
  "postgres",
  "windows",
  "macos",
] as const

export function needsBuild(task: Task): boolean {
  return ["suite", "typecheck", "packages", "artifacts", "web", "desktop", "smoke", "sandbox", "rollout"].includes(
    task.kind,
  )
}

export function executionQueue(unit: Unit, tasks: Task[]): (typeof QUEUES)[number] {
  if (unit.id === "linux-contracts") return "contracts"
  if (unit.pool !== "docker") return unit.pool
  const prepared = tasks
    .filter((task) => task.pool === "docker" && task.needs.includes("benchmark-prepare"))
    .toSorted((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id))
  if (unit.tasks.includes(prepared[0]?.id ?? "")) return "docker-ready"
  return unit.tasks.some((id) => tasks.find((task) => task.id === id)?.needs.includes("benchmark-prepare"))
    ? "docker"
    : "docker-external"
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function documentation(file: string): boolean {
  return /^(README(?:\.[a-zA-Z-]+)?\.md|CONTRIBUTING\.md|LICENSE(?:\.md)?|docs\/(?:research|decisions|postmortem)\/.*\.md)$/.test(
    file,
  )
}

export function selectAffected(changed: string[], base: WorkspaceInput[], head: WorkspaceInput[]) {
  const documentationOnly = changed.length > 0 && changed.every(documentation)
  const all = [...base, ...head]
  const names = new Set<string>()
  let full = false
  for (const file of changed) {
    if (documentation(file)) continue
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

function taskSelected(task: Task, packages: Set<string>, changed: string[], docs: boolean): boolean {
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
  if (task.owners.some((owner) => packages.has(owner))) return true
  const storage = changed.some((file) =>
    /^packages\/harness\/(?:src|test)\/(?:storage|migration|session|execution|permission|lifecycle)\//.test(file),
  )
  if (storage && ["postgres", "rollout", "artifacts", "smoke", "sandbox", "benchmark-docker"].includes(task.kind))
    return true
  const local = packages.has("packages/runtime-local")
  if (local && ["windows", "sandbox", "artifacts", "benchmark-docker"].includes(task.kind)) return true
  if (packages.has("apps/web") && ["web", "desktop"].includes(task.kind)) return true
  const benchmark = changed.some((file) => file.startsWith("benchmark/"))
  if (task.kind.startsWith("benchmark-") && benchmark) return true
  if (task.kind === "benchmark-native") return task.variant === "synergy" && packages.has("packages/harness")
  return false
}

export function buildUnits(tasks: Task[], mode: Mode): Unit[] {
  const units: Unit[] = []
  for (const pool of Object.keys(LIMITS) as Pool[]) {
    const candidates = tasks.filter((task) => task.pool === pool && task.kind !== "benchmark-prepare")
    const contracts = pool === "linux" && mode !== "diagnostic" ? candidates.filter((task) => !needsBuild(task)) : []
    const entries = candidates.filter((task) => !contracts.includes(task))
    if (contracts.length)
      units.push({
        id: "linux-contracts",
        pool,
        tasks: contracts.map((task) => task.id),
        seconds: contracts.reduce((sum, task) => sum + task.seconds, 0),
        browser: false,
        desktop: false,
        sandbox: false,
        build: false,
        policy: contracts.some((task) => task.kind === "policy"),
      })
    if (!entries.length) continue
    // Docker and database cases retain independent job/process ownership.
    const count =
      pool === "linux" ? Math.min(mode === "diagnostic" ? 2 : LIMITS.linux - 1, entries.length) : entries.length
    const bins = Array.from(
      { length: count },
      (_, index): Unit => ({
        id: `${pool}-${index}`,
        pool,
        tasks: [],
        seconds: 0,
        browser: false,
        desktop: false,
        sandbox: false,
        build: false,
        policy: false,
      }),
    )
    for (const task of entries.toSorted((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id))) {
      const target = bins.toSorted((a, b) => a.seconds - b.seconds || a.id.localeCompare(b.id))[0]!
      target.tasks.push(task.id)
      target.seconds += task.seconds
      target.browser ||= task.prerequisites?.includes("browser") ?? false
      target.desktop ||= task.prerequisites?.includes("desktop") ?? false
      target.sandbox ||= task.prerequisites?.includes("sandbox") ?? false
      target.build ||= needsBuild(task)
      target.policy ||= task.kind === "policy"
    }
    for (const bin of bins) bin.tasks.sort((a, b) => Number(b === "policy") - Number(a === "policy"))
    units.push(...bins)
  }
  return units
}

export function createPlan(input: {
  base: string
  head: string
  sha: string
  run: string
  attempt?: string
  mode: Mode
  changed: string[]
  baseWorkspaces: WorkspaceInput[]
  headWorkspaces: WorkspaceInput[]
  tasks: Task[]
  only?: string[]
}): Plan {
  const ids = new Set(input.tasks.map((task) => task.id))
  if (ids.size !== input.tasks.length) throw new Error("Duplicate CI task ID")
  for (const task of input.tasks)
    for (const need of task.needs) if (!ids.has(need)) throw new Error(`Unknown dependency: ${need}`)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string) {
    if (visiting.has(id)) throw new Error(`Cyclic CI dependency: ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of input.tasks.find((task) => task.id === id)!.needs) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
  const impact = selectAffected(input.changed, input.baseWorkspaces, input.headWorkspaces)
  const affected = new Set(impact.packages)
  const proposed = new Set(
    input.tasks
      .filter((task) => impact.full || taskSelected(task, affected, input.changed, impact.documentationOnly))
      .map((task) => task.id),
  )
  function close(selection: Set<string>) {
    for (;;) {
      const before = selection.size
      for (const task of input.tasks) if (selection.has(task.id)) for (const need of task.needs) selection.add(need)
      if (selection.size === before) return selection
    }
  }
  close(proposed)
  const selected =
    input.mode === "diagnostic" ? close(new Set(input.only ?? [])) : input.mode === "affected" ? proposed : ids
  for (const id of selected) if (!ids.has(id)) throw new Error(`Unknown CI task: ${id}`)
  if (!selected.size) throw new Error("CI plan must include at least one task")
  const tasks = input.tasks.toSorted((a, b) => a.id.localeCompare(b.id))
  const body = {
    version: 1 as const,
    base: input.base,
    head: input.head,
    sha: input.sha,
    run: input.run,
    attempt: input.attempt ?? "1",
    mode: input.mode,
    changed: [...new Set(input.changed)].sort(),
    selected: [...selected].sort(),
    proposed: [...proposed].sort(),
    reasons: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        impact.full
          ? "full: shared or unclassified input"
          : proposed.has(task.id)
            ? "affected: owner, consumer, integration, or prerequisite"
            : selected.has(task.id)
              ? `${input.mode}: complete verification`
              : "not affected by this change",
      ]),
    ),
    tasks,
    units: buildUnits(
      tasks.filter((task) => selected.has(task.id)),
      input.mode,
    ),
  }
  return { ...body, digest: hash(body) }
}

export function validatePlan(plan: Plan): void {
  const { digest, ...body } = plan
  if (plan.version !== 1 || hash(body) !== digest) throw new Error("CI plan identity changed")
  const assigned = plan.units.flatMap((unit) => unit.tasks)
  const expected = plan.selected.filter((id) => plan.tasks.find((task) => task.id === id)?.kind !== "benchmark-prepare")
  if (new Set(assigned).size !== assigned.length || assigned.toSorted().join("\0") !== expected.toSorted().join("\0")) {
    throw new Error("CI units do not partition the selected tasks")
  }
}
