import { describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..", "..")
const ciSource = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")

interface ShardEntry {
  shard?: string
  packages?: string
}

const workflow = Bun.YAML.parse(ciSource) as {
  jobs: Record<
    string,
    {
      name?: string
      needs?: string | string[]
      strategy?: { "fail-fast"?: boolean; matrix?: { include?: ShardEntry[] } }
      steps?: Array<{ name?: string; run?: string; env?: Record<string, unknown>; if?: string }>
    }
  >
}

const HARNESS_PACKAGE = "@ericsanchezok/synergy-harness"

/** Every workspace package that declares a test script, keyed by scoped name. */
async function workspaceTestPackages(): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const readManifest = async (dir: string) => {
    try {
      return JSON.parse(await readFile(path.join(root, dir, "package.json"), "utf8")) as {
        name?: string
        scripts?: Record<string, string>
      }
    } catch {
      return null
    }
  }
  for (const scope of ["packages", "apps"]) {
    for (const entry of await readdir(path.join(root, scope))) {
      const dir = path.join(scope, entry)
      const manifest = await readManifest(dir)
      if (manifest?.name && manifest.scripts?.test) found.set(manifest.name, dir)
      if (scope !== "packages") continue
      for (const nested of await readdir(path.join(root, dir))) {
        const nestedDir = path.join(scope, entry, nested)
        const nestedManifest = await readManifest(nestedDir)
        if (nestedManifest?.name && nestedManifest.scripts?.test) found.set(nestedManifest.name, nestedDir)
      }
    }
  }
  return found
}

describe("CI test matrix", () => {
  test("test shards partition the non-harness workspace test packages exactly", async () => {
    const workspace = await workspaceTestPackages()
    expect(workspace.has(HARNESS_PACKAGE)).toBe(true)
    const entries = workflow.jobs["test-shards"]?.strategy?.matrix?.include ?? []
    expect(entries.length).toBeGreaterThan(1)
    const assigned: string[] = []
    for (const entry of entries) {
      expect(entry.shard).toBeTruthy()
      expect(entry.packages).toBeTruthy()
      for (const name of entry.packages!.split(",")) {
        expect(workspace.has(name)).toBe(true)
        assigned.push(name)
      }
    }
    expect(assigned).not.toContain(HARNESS_PACKAGE)
    expect(new Set(assigned).size).toBe(assigned.length)
    expect([...assigned].sort()).toEqual([...workspace.keys()].filter((name) => name !== HARNESS_PACKAGE).sort())
  })

  test("test shards disable fail-fast so every shard reports", () => {
    expect(workflow.jobs["test-shards"]?.strategy?.["fail-fast"]).toBe(false)
  })

  test("test shards keep bounded concurrency and wire the package list through env", () => {
    const shard = workflow.jobs["test-shards"]!
    const turboSteps = shard.steps?.filter((step) => step.run?.includes("bun turbo test")) ?? []
    expect(turboSteps).toHaveLength(1)
    expect(turboSteps[0]!.run).toContain("--concurrency=2")
    expect(turboSteps[0]!.run).toContain('"${filters[@]}"')
    expect(turboSteps[0]!.env?.TEST_PACKAGES).toBe("${{ matrix.packages }}")
    expect(turboSteps[0]!.env?.SYNERGY_LINK_HOME).toBe("/tmp/synergy-link-ci-test")
  })

  test("the aux job owns the browser smoke, plugin UI, and release contracts", () => {
    const aux = workflow.jobs["test-aux"]!
    const runs = aux.steps?.map((step) => step.run ?? "") ?? []
    expect(runs.some((run) => run.includes("private-http-smoke"))).toBe(true)
    expect(runs.some((run) => run.includes("plugin-ui:test"))).toBe(true)
    expect(runs.some((run) => run.includes("release:test"))).toBe(true)
  })

  test("the harness job keeps isolated fresh-process shards and JUnit reports", () => {
    const harness = workflow.jobs["test-harness"]!
    const testStep = harness.steps?.find((step) => step.run?.includes("bun run test:ci"))
    expect(testStep?.env?.SYNERGY_TEST_JUNIT_DIR).toBe("coverage/ci-tests")
    expect(testStep?.env?.SYNERGY_LINK_HOME).toBe("/tmp/synergy-link-ci-test")
    const upload = harness.steps?.find((step) => step.name?.includes("Upload Harness test reports"))
    expect(upload?.if).toBe("always()")
    expect(upload?.run).toBeUndefined()
  })

  test("the anchored Test check fans in exactly the three test jobs", () => {
    const fanIn = workflow.jobs["test"]!
    expect(fanIn.name).toBe("Test")
    expect(fanIn.needs).toEqual(["test-shards", "test-aux", "test-harness"])
    const verify = fanIn.steps?.find((step) => step.run?.includes("needs.test-shards.result"))
    expect(verify?.run).toContain("needs.test-aux.result")
    expect(verify?.run).toContain("needs.test-harness.result")
    expect(verify?.run).toContain("exit 1")
  })

  test("all-checks-passed still anchors on the fan-in, not the leaves", () => {
    const needs = workflow.jobs["all-checks-passed"]!.needs
    const flat = Array.isArray(needs) ? needs : [needs]
    expect(flat).toContain("test")
    for (const leaf of ["test-shards", "test-aux", "test-harness"]) {
      expect(flat).not.toContain(leaf)
    }
  })
})
