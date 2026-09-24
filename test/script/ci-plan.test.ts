import { describe, expect, test } from "bun:test"
import { createPlan, selectAffected, type WorkspaceInput } from "../../script/ci/plan"
import { verifyResults, type TaskResult } from "../../script/ci/evidence"

const workspaces: WorkspaceInput[] = [
  { directory: "packages/core", name: "core", dependencies: [], testDependencies: [] },
  { directory: "packages/consumer", name: "consumer", dependencies: ["core"], testDependencies: [] },
  { directory: "apps/web", name: "web", dependencies: [], testDependencies: ["consumer"] },
  { directory: "packages/independent", name: "independent", dependencies: [], testDependencies: [] },
]

describe("CI impact planning", () => {
  test("includes transitive production and test consumers", () => {
    const selected = selectAffected(["packages/core/src/value.ts"], workspaces, workspaces)
    expect(selected.full).toBe(false)
    expect(selected.packages).toEqual(["apps/web", "packages/consumer", "packages/core"])
  })

  test("uses both revisions when an import or workspace is deleted", () => {
    const head = workspaces.filter((entry) => entry.name !== "core").map((entry) => ({ ...entry, dependencies: [] }))
    expect(selectAffected(["packages/core/src/value.ts"], workspaces, head).packages).toEqual([
      "apps/web",
      "packages/consumer",
      "packages/core",
    ])
  })

  test("selects a consumer introduced on base that is present in the tested merge", () => {
    const base = [
      ...workspaces,
      { directory: "packages/new-consumer", name: "new-consumer", dependencies: ["core"], testDependencies: [] },
    ]
    expect(selectAffected(["packages/core/src/value.ts"], base, workspaces).packages).toContain("packages/new-consumer")
  })

  test.each(["bun.lock", ".github/workflows/ci.yml", "packages/testing/src/env.ts", "unknown/input.json"])(
    "%s cannot silently narrow verification",
    (file) => expect(selectAffected([file], workspaces, workspaces).full).toBe(true),
  )

  test("only explicitly classified documentation bypasses runtime checks", () => {
    expect(selectAffected(["docs/research/ci.md", "README.md"], workspaces, workspaces).documentationOnly).toBe(true)
    expect(selectAffected(["packages/core/src/prompt.md"], workspaces, workspaces).packages).toContain("packages/core")
    expect(selectAffected([".synergy/skill/testing-guide/SKILL.md"], workspaces, workspaces).documentationOnly).toBe(
      false,
    )
  })

  test("shadow and push modes execute every task even when the proposed selection is small", () => {
    const input = {
      base: "a".repeat(40),
      head: "b".repeat(40),
      sha: "c".repeat(40),
      run: "42",
      changed: ["apps/web/src/view.tsx"],
      baseWorkspaces: workspaces,
      headWorkspaces: workspaces,
      tasks: [
        { id: "web", pool: "linux" as const, owners: ["apps/web"], needs: [], seconds: 10, kind: "suite" as const },
        {
          id: "core",
          pool: "linux" as const,
          owners: ["packages/core"],
          needs: [],
          seconds: 10,
          kind: "suite" as const,
        },
      ],
    }
    const plan = createPlan({ ...input, mode: "shadow" })
    expect(plan.selected).toEqual(["core", "web"])
    expect(plan.proposed).toEqual(["web"])
    expect(createPlan({ ...input, mode: "full" }).selected).toEqual(["core", "web"])
  })
})

describe("CI completion evidence", () => {
  const plan = createPlan({
    base: "a".repeat(40),
    head: "b".repeat(40),
    sha: "c".repeat(40),
    run: "42",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: [{ id: "postgres-18", pool: "postgres", owners: [], needs: [], seconds: 10, kind: "postgres" }],
  })
  const result: TaskResult = {
    version: 1,
    task: "postgres-18",
    plan: plan.digest,
    sha: plan.sha,
    run: plan.run,
    attempt: plan.attempt,
    mode: "full",
    status: "success",
    exitCode: 0,
    started: "2026-09-24T00:00:00Z",
    completed: "2026-09-24T00:00:01Z",
    reports: [],
    steps: [{ name: "postgres-tests", seconds: 1, exitCode: 0 }],
  }

  test("requires every planned task and successful job status", () => {
    expect(verifyResults(plan, [result], ["success"])).toEqual([])
    expect(verifyResults(plan, [], ["success"]).join(" ")).toContain("postgres-18")
    expect(verifyResults(plan, [result], ["cancelled"]).length).toBeGreaterThan(0)
    expect(verifyResults(plan, [result, result], ["success"]).length).toBeGreaterThan(0)
  })

  test.each([
    { sha: "d".repeat(40) },
    { run: "41" },
    { attempt: "0" },
    { plan: "old-plan" },
    { mode: "diagnostic" },
    { status: "failure", exitCode: 1 },
    { task: "unplanned" },
  ])("rejects stale, failed, diagnostic, or foreign results: %j", (change) => {
    expect(verifyResults(plan, [{ ...result, ...change } as TaskResult], ["success"]).length).toBeGreaterThan(0)
  })
})
