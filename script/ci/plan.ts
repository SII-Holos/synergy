import { selectAffected, taskSelected, type SelectionChanges } from "./selection"
export { documentation, selectAffected } from "./selection"
import { createHash } from "node:crypto"

// Provenance: https://docs.github.com/en/actions/reference/limits
// Local adaptation: use Free's shared 20-job capacity with bounded pools; preparation and concurrent PRs may still queue.

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
  | "environment"

export interface WorkspaceInput {
  directory: string
  name: string
  dependencies: string[]
  testDependencies: string[]
}

export interface TaskInputs {
  files: string[]
  packages: string[]
  complete: boolean
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
  selection?: string
  inputs?: string[]
  scenarios?: string[]
  scenarioPrefix?: string
  profile?: "core" | "full"
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
  benchmark: boolean
  core: boolean
  full: boolean
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
  timings?: string
  timingSnapshot?: import("./timing").Timings
  timingSource?: string
  fullTriggers?: import("./selection").FullTrigger[]
}

export const LIMITS: Record<Pool, number> = { linux: 12, docker: 8, postgres: 1, windows: 1, macos: 1 }
export const QUEUES = [
  "contracts",
  "linux",
  "linux_core",
  "linux_full",
  "docker_direct",
  "docker",
  "postgres",
  "windows",
  "macos",
] as const

export function needsBuild(task: Task): boolean {
  return ["suite", "typecheck", "artifacts", "web", "desktop", "smoke", "sandbox", "rollout"].includes(task.kind)
}

export function executionQueue(unit: Unit, _tasks?: Task[]): (typeof QUEUES)[number] {
  if (unit.id === "linux-contracts") return "contracts"
  if (unit.pool === "linux") return unit.full ? "linux_full" : unit.core ? "linux_core" : "linux"
  if (unit.pool === "docker" && !unit.benchmark) return "docker_direct"
  return unit.pool
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function unitWorkers(pool: Pool, mode: Mode, contracts = false) {
  return mode !== "diagnostic" && !contracts && (pool === "linux" || pool === "docker") ? 2 : 1
}

export function taskOrder(a: Task, b: Task) {
  return Number(b.kind === "policy") - Number(a.kind === "policy") || b.seconds - a.seconds || a.id.localeCompare(b.id)
}

function finishTime(tasks: Task[], workers: number) {
  const lanes = Array.from({ length: workers }, () => 0)
  for (const task of tasks.toSorted(taskOrder)) {
    lanes.sort((a, b) => a - b)
    lanes[0]! += task.seconds
  }
  return Math.max(...lanes)
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
        tasks: contracts.toSorted(taskOrder).map((task) => task.id),
        seconds: contracts.reduce((sum, task) => sum + task.seconds, 0),
        browser: false,
        desktop: false,
        sandbox: false,
        build: false,
        policy: contracts.some((task) => task.kind === "policy"),
        benchmark: false,
        core: false,
        full: false,
      })
    if (!entries.length) continue
    const ordinary = entries.filter((task) => !task.profile)
    const core = entries.filter((task) => task.profile === "core")
    const full = entries.filter((task) => task.profile === "full")
    const direct = entries.filter((task) => !task.needs.includes("benchmark-prepare"))
    const benchmark = entries.filter((task) => task.needs.includes("benchmark-prepare"))
    const groups =
      pool === "linux" && mode !== "diagnostic"
        ? [
            {
              entries: ordinary,
              count: Math.min(6, ordinary.length),
              name: "linux",
            },
            { entries: core, count: Math.min(1, core.length), name: "linux-core" },
            { entries: full, count: Math.min(4, full.length), name: "linux-full" },
          ]
        : pool === "docker" && mode !== "diagnostic"
          ? [
              {
                entries: direct,
                count: Math.min(2, direct.length),
                name: "docker-direct",
              },
              {
                entries: benchmark,
                count: Math.min(6, benchmark.length),
                name: "docker",
              },
            ]
          : [
              {
                entries,
                count: pool === "linux" || pool === "docker" ? Math.min(2, entries.length) : entries.length,
                name: pool,
              },
            ]
    for (const group of groups) {
      const count = group.count
      const bins = Array.from(
        { length: count },
        (_, index): Unit => ({
          id: `${group.name}-${index}`,
          pool,
          tasks: [],
          seconds: 0,
          browser: false,
          desktop: false,
          sandbox: false,
          build: false,
          policy: false,
          benchmark: false,
          core: false,
          full: false,
        }),
      )
      for (const task of group.entries.toSorted(
        (a, b) =>
          (pool === "docker"
            ? Number(a.needs.includes("benchmark-prepare")) - Number(b.needs.includes("benchmark-prepare"))
            : 0) ||
          b.seconds - a.seconds ||
          a.id.localeCompare(b.id),
      )) {
        const eligible =
          pool === "linux" && mode !== "diagnostic" && task.kind === "suite"
            ? bins.filter((bin) =>
                bin.tasks.every((id) => tasks.find((entry) => entry.id === id)!.package !== task.package),
              )
            : bins
        const assigned = (bin: Unit) => bin.tasks.map((id) => tasks.find((entry) => entry.id === id)!)
        const predicted = (bin: Unit) => finishTime([...assigned(bin), task], unitWorkers(pool, mode))
        const target = eligible.toSorted(
          (a, b) =>
            predicted(a) - predicted(b) ||
            assigned(a).reduce((sum, entry) => sum + entry.seconds, 0) -
              assigned(b).reduce((sum, entry) => sum + entry.seconds, 0) ||
            a.id.localeCompare(b.id),
        )[0]!
        target.seconds = predicted(target)
        target.tasks.push(task.id)
        target.browser ||= task.prerequisites?.includes("browser") ?? false
        target.desktop ||= task.prerequisites?.includes("desktop") ?? false
        target.sandbox ||= task.prerequisites?.includes("sandbox") ?? false
        target.build ||= needsBuild(task)
        target.policy ||= task.kind === "policy"
        target.benchmark ||= task.needs.includes("benchmark-prepare")
        target.core ||= task.profile === "core"
        target.full ||= task.profile === "full"
      }
      for (const bin of bins)
        bin.tasks.sort((a, b) => taskOrder(tasks.find((task) => task.id === a)!, tasks.find((task) => task.id === b)!))
      if (pool !== "linux" && pool !== "docker") for (const bin of bins) bin.id = bin.tasks[0]!
      units.push(...bins.toSorted((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id)))
    }
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
  baseInputs?: Record<string, TaskInputs>
  headInputs?: Record<string, TaskInputs>
  tasks: Task[]
  only?: string[]
  timings?: string
  timingSnapshot?: import("./timing").Timings
  timingSource?: string
  selectionChanges?: SelectionChanges
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
  const knownTests = input.tasks
    .flatMap((task) => task.files ?? [])
    .filter((file) => file.startsWith("test/script/") && file.endsWith(".test.ts"))
  const impact = selectAffected(
    input.changed,
    input.baseWorkspaces,
    input.headWorkspaces,
    knownTests,
    input.selectionChanges,
  )
  const affected = new Set(impact.packages)
  const proposed = new Set(
    input.tasks
      .filter(
        (task) =>
          impact.full ||
          taskSelected(
            task,
            affected,
            input.changed,
            impact.documentationOnly,
            input.baseInputs?.[task.id],
            input.headInputs?.[task.id],
            { ...input.selectionChanges, runtimePackages: impact.runtimePackages },
          ),
      )
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
    ...(input.timings ? { timings: input.timings } : {}),
    ...(input.timingSnapshot ? { timingSnapshot: input.timingSnapshot, timingSource: input.timingSource } : {}),
    mode: input.mode,
    changed: [...new Set(input.changed)].sort(),
    selected: [...selected].sort(),
    proposed: [...proposed].sort(),
    ...(impact.fullTriggers.length ? { fullTriggers: impact.fullTriggers } : {}),
    reasons: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        impact.full
          ? "full: shared or unclassified input"
          : proposed.has(task.id)
            ? `affected: ${input.changed
                .filter((file) => !impact.documentationOnly || file.startsWith("docs/"))
                .slice(0, 5)
                .join(", ")} → ${task.owners.filter((owner) => affected.has(owner)).join(", ") || task.id}`
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
  const files = new Set<string>()
  for (const task of plan.tasks.filter((task) => plan.selected.includes(task.id) && task.kind === "suite"))
    for (const file of task.files ?? []) {
      const key = `${task.package}/${file}`
      if (files.has(key)) throw new Error(`Repeated test file in CI plan: ${key}`)
      files.add(key)
    }
}
