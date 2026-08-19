import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { gatesForMode } from "../../script/gates"

const root = path.resolve(import.meta.dir, "..", "..")
const ciSource = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")

const REQUIRED_NEEDS = [
  "quality",
  "typecheck",
  "windows",
  "test",
  "package-validation",
  "workflow-validation",
  "secret-scan",
  "desktop",
  "smoke",
  "coverage",
]

function parseJobNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/^  ([a-z][a-z0-9-]*):\n    name:/gm)) {
    names.push(match[1]!)
  }
  return names
}

function parseJobNeeds(source: string, job: string): string[] {
  const jobBlock = source.split(new RegExp(`^  ${job}:`, "m"))[1] ?? ""
  const needsBlock = jobBlock.split("\n    steps:", 1)[0] ?? ""
  const needsSection = needsBlock.match(/needs:\n([\s\S]*?)(?=\n    \w|\n  \w|$)/)?.[1] ?? ""
  return needsSection
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean)
}

describe("CI topology", () => {
  test("all-checks-passed exists with if: always()", () => {
    const block = ciSource.split("  all-checks-passed:")[1] ?? ""
    expect(block).toContain("if: always()")
    expect(block).toContain("name: All checks passed")
  })

  test("all-checks-passed needs exactly the blocking matrix", () => {
    const needs = parseJobNeeds(ciSource, "all-checks-passed")
    expect(needs.sort()).toEqual([...REQUIRED_NEEDS].sort())
  })

  test("all-checks-passed hard-fails on any non-success result", () => {
    const block = ciSource.split("  all-checks-passed:")[1] ?? ""
    expect(block).toContain('if [ "$result" != "success" ]')
    expect(block).toContain("exit 1")
    expect(block).toContain("GitHub counts a skipped required check as passing")
  })

  test("quality job runs the ci-static gate cluster", () => {
    const block = ciSource.split("  quality:")[1]?.split("  typecheck:")[0] ?? ""
    expect(block).toContain("bun script/gates.ts ci-static")
    expect(block).toContain("SYNERGY_GATE_CONCURRENCY: 4")
  })

  test("coverage job runs the ci-coverage gate cluster", () => {
    const block = ciSource.split("  coverage:")[1]?.split("  all-checks-passed:")[0] ?? ""
    expect(block).toContain("bun script/gates.ts ci-coverage")
    expect(block).toContain("timeout-minutes: 45")
  })

  test("the blocking matrix has exactly the ten required jobs", () => {
    const jobs = parseJobNames(ciSource)
    const blocking = jobs.filter((job) => job !== "all-checks-passed")
    expect(blocking.sort()).toEqual([...REQUIRED_NEEDS].sort())
  })
})

describe("gate modes", () => {
  test("ci-static excludes secrets, workflow, and coverage", () => {
    const ids = gatesForMode("ci-static").map((gate) => gate.id)
    expect(ids).not.toContain("secrets:check")
    expect(ids).not.toContain("workflow:check")
    expect(ids).not.toContain("coverage:check")
    expect(ids).toContain("doc:check")
    expect(ids).toContain("decision:check")
    expect(ids).toContain("browser-crypto:check")
  })

  test("ci-coverage runs exactly the coverage gate", () => {
    const ids = gatesForMode("ci-coverage").map((gate) => gate.id)
    expect(ids).toEqual(["coverage:check"])
  })

  test("local excludes coverage and browser-crypto but keeps the rest", () => {
    const ids = gatesForMode("local").map((gate) => gate.id)
    expect(ids).not.toContain("coverage:check")
    expect(ids).not.toContain("browser-crypto:check")
    expect(ids).toContain("format:check")
    expect(ids).toContain("workflow:check")
  })
})
