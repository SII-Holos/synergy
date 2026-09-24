import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { LIMITS } from "../../script/ci/plan"

const root = path.resolve(import.meta.dir, "../..")
interface Job {
  name?: string
  if?: string
  needs?: string[]
  strategy?: { "max-parallel": number; "fail-fast": boolean }
  steps?: { run?: string; uses?: string; with?: Record<string, unknown> }[]
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
      docker: LIMITS.docker - 1,
      "docker-external": 2,
      "docker-ready": 1,
      postgres: LIMITS.postgres,
      windows: LIMITS.windows,
    })) {
      const job = workflow.jobs[pool]!
      expect(job.strategy?.["max-parallel"]).toBe(limit)
      expect(job.strategy?.["fail-fast"]).toBe(false)
      expect(job.steps?.some((step) => step.with?.["if-no-files-found"] === "error")).toBe(true)
    }
    expect(workflow.jobs.contracts!.needs).toEqual(["plan"])
    expect(workflow.jobs["docker-external"]!.needs).toEqual(["plan"])
    expect(workflow.jobs.docker!.needs).toContain("docker-external")
    expect(workflow.jobs["docker-ready"]!.needs).toEqual(["plan", "benchmark-prepare"])
  })
  test("every dev/main push and the daily cold run remain enabled", () => {
    expect(workflow.on.push.branches).toEqual(["dev", "main"])
    expect(workflow.on.schedule.length).toBe(1)
    expect(workflow.concurrency["cancel-in-progress"]).toContain("pull_request")
  })
  test("diagnostics has one execution matrix capped at two and no required check", async () => {
    const diagnostic = Bun.YAML.parse(
      await readFile(path.join(root, ".github/workflows/ci-diagnostic.yml"), "utf8"),
    ) as { jobs: Record<string, Job> }
    expect(diagnostic.jobs.execute?.strategy?.["max-parallel"]).toBe(2)
    expect(Object.values(diagnostic.jobs).some((job) => job.name === "All checks passed")).toBe(false)
  })
})
