import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { catalog } from "../../script/ci/catalog"
import { createPlan, executionQueue, LIMITS } from "../../script/ci/plan"
import { latestExecutions } from "../../script/ci/github"

const root = path.resolve(import.meta.dir, "../..")
interface Job {
  name?: string
  if?: string
  needs?: string[]
  strategy?: { "max-parallel": number; "fail-fast": boolean }
  steps?: { name?: string; if?: string | boolean; run?: string; uses?: string; with?: Record<string, unknown> }[]
}
const workflow = Bun.YAML.parse(await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")) as {
  on: { push: { branches: string[] }; schedule: unknown[] }
  concurrency: { "cancel-in-progress": string }
  jobs: Record<string, Job>
}

describe("required CI topology", () => {
  test("independent task-home scenarios can complete on separate workers", async () => {
    const tasks = await catalog()
    const controls = tasks.filter((task) => task.id.startsWith("native-synergy-task-home-"))
    expect(controls.flatMap((task) => task.scenarios ?? []).sort()).toEqual([
      "test_synergy_preserves_task_home_and_native_stopping[empty-provider-stop]",
      "test_synergy_preserves_task_home_and_native_stopping[tool-roundtrip]",
    ])
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks,
    })
    const workers = controls.map((task) => plan.units.find((unit) => unit.tasks.includes(task.id))!.id)
    expect(new Set(workers).size).toBe(2)
  })
  test("package partitions occupy different runners even when historical weights are uneven", async () => {
    const tasks = await catalog()
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks,
    })
    for (const unit of plan.units.filter((unit) => unit.pool === "linux")) {
      const suites = tasks.filter((task) => unit.tasks.includes(task.id) && task.kind === "suite")
      expect(new Set(suites.map((task) => task.package)).size).toBe(suites.length)
    }
  })
  test("consumers join only their required producer without reserving waiting runners", async () => {
    const tasks = await catalog()
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks,
    })
    for (const unit of plan.units) {
      const entries = tasks.filter((task) => unit.tasks.includes(task.id))
      if (unit.pool === "linux" && unit.id !== "linux-contracts") {
        const profiles = new Set(entries.map((task) => task.profile ?? "ordinary"))
        expect(profiles.size).toBe(1)
        const job = workflow.jobs[executionQueue(unit)]!
        if (unit.full) expect(job.needs).toContain("prepare-full")
        else if (unit.core) expect(job.needs).toContain("prepare-core")
        else {
          expect(job.needs).not.toContain("prepare-full")
          expect(job.needs).not.toContain("prepare-core")
        }
      }
      if (unit.pool === "docker") {
        expect(entries.every((task) => task.needs.includes("benchmark-prepare") === unit.benchmark)).toBe(true)
        const job = workflow.jobs[executionQueue(unit)]!
        if (unit.benchmark) expect(job.needs).toContain("benchmark-prepare")
        else expect(job.needs).not.toContain("benchmark-prepare")
      }
    }
    const jobs = plan.units.map((unit) => ({
      name: workflow.jobs[executionQueue(unit)]!.name!.replace("${{ matrix.id }}", unit.id),
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    }))
    expect(
      latestExecutions(plan, jobs)
        .map((job) => job.unit)
        .sort(),
    ).toEqual(plan.units.map((unit) => unit.id).sort())
  })
  test("the stable required check waits for every executor, including PostgreSQL", () => {
    const gate = workflow.jobs["all-checks-passed"]!
    expect(gate.name).toBe("All checks passed")
    expect(gate.if).toBe("always()")
    expect(gate.needs?.toSorted()).toEqual(
      Object.keys(workflow.jobs)
        .filter((id) => id !== "all-checks-passed")
        .sort(),
    )
    expect(gate.steps?.some((step) => step.run?.includes("ci.ts verify"))).toBe(true)
  })
  test("all execution queues are bounded and preserve failed reports", () => {
    for (const [pool, limit] of Object.entries({
      linux: 8,
      linux_core: 1,
      linux_full: 5,
      docker_direct: 2,
      contracts: 1,
      docker: 6,
      postgres: LIMITS.postgres,
      windows: LIMITS.windows,
      macos: LIMITS.macos,
    })) {
      const job = workflow.jobs[pool]!
      expect(job.strategy?.["max-parallel"]).toBe(limit)
      expect(job.strategy?.["fail-fast"]).toBe(false)
      expect(job.steps?.some((step) => step.with?.["if-no-files-found"] === "error")).toBe(true)
    }
    expect(workflow.jobs.contracts!.needs).toEqual(["plan"])
    expect(workflow.jobs.docker_direct!.needs).toEqual(["plan"])
    expect(workflow.jobs.docker!.needs).toEqual(["plan", "benchmark-prepare"])
    expect(Object.keys(workflow.jobs).filter((name) => name.startsWith("docker"))).toEqual(["docker_direct", "docker"])
  })
  test("every dev/main push and the daily cold run remain enabled", () => {
    expect(workflow.on.push.branches).toEqual(["dev", "main"])
    expect(workflow.on.schedule.length).toBe(1)
    expect(workflow.concurrency["cancel-in-progress"]).toContain("pull_request")
  })
  test("every planned consumer downloads the original plan before executing", () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const execute =
        job.steps?.findIndex((step) => /ci\.ts (?:run|verify|prepare-distributions)/.test(step.run ?? "")) ?? -1
      if (execute < 0) continue
      const download = job.steps!.findIndex(
        (step) =>
          step.uses?.startsWith("actions/download-artifact@") &&
          step.with?.name === "ci-plan-${{ needs.plan.outputs.attempt }}",
      )
      expect(download, id).toBeGreaterThanOrEqual(0)
      expect(download, id).toBeLessThan(execute)
    }
  })
  test("bounded Docker groups retain each business task once and share preparation", async () => {
    const tasks = await catalog()
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks,
    })
    const controls = tasks.filter(
      (task) => task.id.startsWith("native-synergy-semantics-") || task.id === "native-synergy-compaction",
    )
    const docker = plan.units.filter((unit) => unit.pool === "docker")
    expect(docker).toHaveLength(LIMITS.docker)
    expect(docker.some((unit) => unit.tasks.length > 1)).toBe(true)
    expect(controls).toHaveLength(5)
    const units = controls.map((task) => {
      const assigned = plan.units.filter((unit) => unit.tasks.includes(task.id))
      expect(assigned).toHaveLength(1)
      expect(executionQueue(assigned[0]!, tasks)).toBe("docker")
      return assigned[0]!.id
    })
    expect(new Set(units).size).toBeGreaterThan(0)
    expect(docker.flatMap((unit) => unit.tasks).toSorted()).toEqual(
      plan.selected
        .filter((id) => tasks.find((task) => task.id === id)!.pool === "docker" && id !== "benchmark-prepare")
        .toSorted(),
    )
  })
  test("every prepared benchmark consumer restores its artifact before executing", async () => {
    const tasks = await catalog()
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks,
    })
    const archive = ".artifacts/ci/benchmark.tar.zst"
    const producer = workflow.jobs["benchmark-prepare"]!.steps!.find(
      (step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.path === archive,
    )!
    expect(producer).toBeDefined()
    const consumers = tasks.filter((task) => task.needs.includes("benchmark-prepare"))
    expect(consumers.length).toBeGreaterThan(0)
    for (const task of consumers) {
      const units = plan.units.filter((unit) => unit.tasks.includes(task.id))
      expect(units).toHaveLength(1)
      const job = workflow.jobs[executionQueue(units[0]!, tasks)]!
      expect(job.needs, task.id).toContain("benchmark-prepare")
      expect(units[0]!.benchmark, task.id).toBe(true)
      expect(job.steps!.some((step) => step.name === "Execute planned tasks")).toBe(true)
    }
  })
  test("diagnostics has one execution matrix capped at two and no required check", async () => {
    const diagnostic = Bun.YAML.parse(
      await readFile(path.join(root, ".github/workflows/ci-diagnostic.yml"), "utf8"),
    ) as { jobs: Record<string, Job> }
    expect(diagnostic.jobs.execute?.strategy?.["max-parallel"]).toBe(2)
    expect(Object.values(diagnostic.jobs).some((job) => job.name === "All checks passed")).toBe(false)
  })
})
