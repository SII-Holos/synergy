import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { catalog } from "../../script/ci/catalog"
import { createPlan, executionQueue, LIMITS } from "../../script/ci/plan"

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
      linux: LIMITS.linux - 1,
      contracts: 1,
      docker: LIMITS.docker,
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
    expect(workflow.jobs.docker!.needs).toEqual(["plan"])
    expect(Object.keys(workflow.jobs).filter((name) => name.startsWith("docker"))).toEqual(["docker"])
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
      expect(job.needs, task.id).not.toContain("benchmark-prepare")
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
