import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { loadManifest } from "../../script/coverage-check"
import { gatesForMode } from "../../script/gates"

const root = path.resolve(import.meta.dir, "..", "..")
const ciSource = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")

interface MatrixEntry {
  group?: string
  packages?: string
}

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  if?: string
}

const workflow = Bun.YAML.parse(ciSource) as {
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean }
  jobs: Record<
    string,
    {
      name?: string
      needs?: string | string[]
      strategy?: { "fail-fast"?: boolean; matrix?: { include?: MatrixEntry[] } }
      steps?: WorkflowStep[]
    }
  >
}

describe("CI coverage matrix", () => {
  test("coverage shards partition the coverage manifest exactly", async () => {
    const manifest = await loadManifest(root)
    const entries = workflow.jobs["coverage-shards"]?.strategy?.matrix?.include ?? []
    expect(entries.length).toBeGreaterThan(1)
    const assigned: string[] = []
    for (const entry of entries) {
      expect(entry.group).toBeTruthy()
      expect(entry.packages).toBeTruthy()
      for (const pkg of entry.packages!.split(",")) {
        expect(manifest.packages[pkg]).toBeDefined()
        assigned.push(pkg)
      }
    }
    expect(new Set(assigned).size).toBe(assigned.length)
    expect([...assigned].sort()).toEqual(Object.keys(manifest.packages).sort())
  })

  test("coverage shards disable fail-fast so every shard reports", () => {
    expect(workflow.jobs["coverage-shards"]?.strategy?.["fail-fast"]).toBe(false)
  })

  test("every coverage shard uploads its lcov reports", () => {
    const shard = workflow.jobs["coverage-shards"]!
    const upload = shard.steps?.find((step) => step.uses?.startsWith("actions/upload-artifact"))
    expect(upload?.with?.name).toBe("coverage-lcov-${{ matrix.group }}")
    const paths = String(upload?.with?.path)
    expect(paths).toContain("coverage-shard-anchor.txt")
    expect(paths).toContain("packages/*/coverage/lcov.info")
    expect(paths).toContain("packages/*/*/coverage/lcov.info")
    expect(paths).toContain("coverage/shards/*/lcov.info")
    expect(paths).toContain("apps/*/coverage")
    expect(upload?.with?.["if-no-files-found"]).toBe("error")
  })

  test("coverage shard commands run manifest commands via execute-only", () => {
    const shard = workflow.jobs["coverage-shards"]!
    const gate = shard.steps?.find((step) => step.run?.includes("coverage-check.ts"))
    expect(gate?.run).toContain("--execute-only")
    expect(gate?.run).toContain('--package "$COVERAGE_PACKAGES"')
    expect(gate?.env?.COVERAGE_PACKAGES).toBe("${{ matrix.packages }}")
  })

  test("the Coverage job aggregates shard reports instead of running commands", () => {
    const coverage = workflow.jobs["coverage"]!
    expect(coverage.needs).toEqual(["coverage-shards"])
    const download = coverage.steps?.find((step) => step.uses?.startsWith("actions/download-artifact"))
    expect(download?.with?.pattern).toBe("coverage-lcov-*")
    expect(download?.with?.["merge-multiple"]).toBe(true)
    const gate = coverage.steps?.find((step) => step.run?.includes("coverage-check.ts"))
    expect(gate?.run).toContain("--aggregate")
    expect(gate?.run).not.toContain("gates.ts")
  })

  test("ci-static runs the ci-matrix contract", () => {
    expect(gatesForMode("ci-static").map((gate) => gate.id)).toContain("ci-matrix:check")
  })

  test("concurrency cancels superseded PR runs but never dev pushes", () => {
    const concurrency = workflow.concurrency
    expect(concurrency?.group).toBe("ci-${{ github.ref }}")
    expect(String(concurrency?.["cancel-in-progress"])).toContain("pull_request")
  })

  test("the dev ruleset anchored check names all remain present", () => {
    const names = Object.values(workflow.jobs).map((job) => job.name ?? "")
    for (const required of [
      "Typecheck",
      "Test",
      "Quality",
      "Desktop Checks",
      "Secret Scan",
      "Package Validation",
      "Workflow Validation",
      "Smoke Test",
    ]) {
      expect(names).toContain(required)
    }
  })
})
