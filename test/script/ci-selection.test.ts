import { describe, expect, test } from "bun:test"
import { coverageChanges } from "../../script/ci/coverage-selection"
import { selectAffected, taskSelected } from "../../script/ci/selection"
import type { Task, WorkspaceInput } from "../../script/ci/plan"
import { createPlan } from "../../script/ci/plan"
import { catalog } from "../../script/ci/catalog"

const workspaces: WorkspaceInput[] = [
  { directory: "packages/core", name: "core", dependencies: [], testDependencies: [] },
  { directory: "packages/consumer", name: "consumer", dependencies: ["core"], testDependencies: [] },
  { directory: "apps/web", name: "web", dependencies: [], testDependencies: [] },
]
const owner = {
  command: "bun run test:coverage",
  lcov: "coverage/lcov.info",
  thresholds: { lines: 60, functions: 50 },
  exempt: [{ glob: "src/entry.ts", reason: "Executed in the child process fixture" }],
}
const manifest = () => ({ packages: { "packages/core": structuredClone(owner), "apps/web": structuredClone(owner) } })
const task = (extra: Partial<Task>): Task => ({
  id: "fixture",
  kind: "suite",
  pool: "linux",
  owners: ["packages/core"],
  needs: [],
  seconds: 1,
  ...extra,
})

describe("coverage manifest impact", () => {
  test("an existing package's exact exemptions retain its complete suite and consumers", () => {
    const base = manifest()
    const head = manifest()
    head.packages["packages/core"].exempt = [{ glob: "src/worker.ts", reason: "Verified by a process fixture" }]
    const coverage = coverageChanges(base, head, workspaces, workspaces)
    expect(coverage).toEqual({
      complete: true,
      packages: ["packages/core"],
      files: ["packages/core/src/entry.ts", "packages/core/src/worker.ts"],
    })
    const impact = selectAffected(["script/coverage-exempt.json"], workspaces, workspaces, [], { coverage })
    expect(impact.full).toBe(false)
    expect(impact.packages).toEqual(["packages/consumer", "packages/core"])
    expect(impact.runtimePackages).toEqual(impact.packages)
    expect(
      taskSelected(
        task({ kind: "suite" }),
        new Set(impact.packages),
        ["script/coverage-exempt.json"],
        false,
        undefined,
        undefined,
        {
          coverage,
          runtimePackages: impact.runtimePackages,
        },
      ),
    ).toBe(true)
  })

  test("reason edits are owned changes and JSON object ordering is irrelevant", () => {
    const base = manifest()
    const head = manifest()
    head.packages["apps/web"].exempt[0]!.reason = "Verified by the browser lifecycle fixture"
    const coverage = coverageChanges(base, head, workspaces, workspaces)
    expect(coverage.packages).toEqual(["apps/web"])
    expect(coverage.files).toEqual(["apps/web/src/entry.ts"])
    expect(
      coverageChanges(
        base,
        { packages: { "apps/web": base.packages["apps/web"], "packages/core": base.packages["packages/core"] } },
        workspaces,
        workspaces,
      ),
    ).toEqual({ complete: true, packages: [], files: [] })
  })

  test.each([
    { command: "bun run another-command" },
    { lcov: "another.info" },
    { thresholds: { lines: 61, functions: 50 } },
    { maxExemptShare: 0.5 },
    { unknown: true },
    { exempt: [{ glob: "src/**", reason: "Too broad" }] },
    { exempt: [{ glob: "src/../outside.ts", reason: "Outside source" }] },
    { exempt: [{ glob: "src/entry.ts", reason: "" }] },
    { exempt: [{ glob: "src/entry.ts", reason: "Valid", unknown: true }] },
    { exempt: [owner.exempt[0], owner.exempt[0]] },
  ])("unknown or non-exemption package changes stay full: %j", (change) => {
    const base = manifest()
    const head = { packages: { ...base.packages, "packages/core": { ...owner, ...change } } }
    expect(coverageChanges(base, head, workspaces, workspaces).complete).toBe(false)
  })

  test("missing manifests, unknown structure and new packages cannot narrow selection", () => {
    const base = manifest()
    for (const head of [
      undefined,
      null,
      [],
      { ...base, version: 2 },
      { packages: {} },
      { packages: { ...base.packages, "packages/new": owner } },
    ]) {
      const coverage = coverageChanges(base, head, workspaces, workspaces)
      expect(coverage.complete).toBe(false)
      expect(selectAffected(["script/coverage-exempt.json"], workspaces, workspaces, [], { coverage }).full).toBe(true)
    }
    expect(
      coverageChanges(
        base,
        base,
        workspaces,
        workspaces.filter((entry) => entry.name !== "core"),
      ).complete,
    ).toBe(false)
  })

  test("a manifest edit cannot mask a concurrent shared script change", () => {
    const coverage = coverageChanges(manifest(), manifest(), workspaces, workspaces)
    expect(
      selectAffected(["script/coverage-exempt.json", "script/ci/run.ts"], workspaces, workspaces, [], { coverage })
        .full,
    ).toBe(true)
  })

  test("an exemption edit still selects integration inputs for the affected source", () => {
    const base = manifest()
    const head = manifest()
    head.packages["packages/core"].exempt.push({
      glob: "src/storage.ts",
      reason: "Verified in a real database fixture",
    })
    const coverage = coverageChanges(base, head, workspaces, workspaces)
    const inputs = { complete: true, files: ["packages/core/src/storage.ts"], packages: [] }
    const integration = task({ kind: "postgres", inputs: ["packages/core/test/storage.test.ts"] })
    expect(
      taskSelected(integration, new Set(["packages/core"]), ["script/coverage-exempt.json"], false, inputs, inputs, {
        coverage,
        runtimePackages: ["packages/core"],
      }),
    ).toBe(true)
  })
})

describe("test entry impact", () => {
  const file = "packages/core/test/value.test.ts"
  const changes = { leafTests: [file] }

  test("a proven leaf runs its owning suite without propagating production impact", () => {
    const impact = selectAffected([file], workspaces, workspaces, [], changes)
    expect(impact.full).toBe(false)
    expect(impact.packages).toEqual(["packages/core"])
    expect(impact.runtimePackages).toEqual([])
    const context = { ...changes, runtimePackages: impact.runtimePackages }
    expect(taskSelected(task({}), new Set(impact.packages), [file], false, undefined, undefined, context)).toBe(true)
    expect(
      taskSelected(task({ kind: "artifacts" }), new Set(impact.packages), [file], false, undefined, undefined, context),
    ).toBe(false)
    expect(
      taskSelected(
        task({ kind: "windows", files: [file] }),
        new Set(impact.packages),
        [file],
        false,
        undefined,
        undefined,
        context,
      ),
    ).toBe(true)
  })

  test("shared tests and production changes preserve the reverse closure", () => {
    expect(selectAffected([file], workspaces, workspaces).packages).toContain("packages/consumer")
    expect(
      selectAffected(["packages/core/test/support/value.ts"], workspaces, workspaces, [], changes).packages,
    ).toContain("packages/consumer")
    expect(
      selectAffected([file, "packages/core/src/value.ts"], workspaces, workspaces, [], changes).runtimePackages,
    ).toEqual(["packages/consumer", "packages/core"])
  })

  test("an explicitly registered integration test still selects its task", () => {
    const integration = task({ kind: "rollout", inputs: [file] })
    expect(
      taskSelected(integration, new Set(["packages/core"]), [file], false, undefined, undefined, {
        ...changes,
        runtimePackages: [],
      }),
    ).toBe(true)
  })

  test("a leaf test is retained in a mixed adapter change", () => {
    const impact = selectAffected(
      [file, "benchmark/runtime/capture-pi.mjs"],
      [...workspaces, { directory: "benchmark", name: "benchmark", dependencies: [], testDependencies: [] }],
      workspaces,
      [],
      changes,
    )
    expect(
      taskSelected(
        task({}),
        new Set(impact.packages),
        [file, "benchmark/runtime/capture-pi.mjs"],
        false,
        undefined,
        undefined,
        { ...changes, runtimePackages: impact.runtimePackages },
      ),
    ).toBe(true)
  })
})

describe("native benchmark input routing", () => {
  const native = (variant: string) =>
    task({ id: `native-${variant}`, kind: "benchmark-native", pool: "docker", owners: [], variant })

  test("mixed product and adapter edits select their actual harnesses", () => {
    const changed = ["packages/harness/src/session/invoke.ts", "benchmark/runtime/capture-pi.mjs"]
    for (const variant of ["synergy", "pi"])
      expect(taskSelected(native(variant), new Set(["packages/harness"]), changed, false)).toBe(true)
    for (const variant of ["codex", "opencode", "deepseek"])
      expect(taskSelected(native(variant), new Set(["packages/harness"]), changed, false)).toBe(false)
    expect(
      taskSelected(
        task({ id: "benchmark-docker-pi-compaction", kind: "benchmark-docker", pool: "docker", owners: ["benchmark"] }),
        new Set(["packages/harness", "benchmark"]),
        changed,
        false,
      ),
    ).toBe(true)
  })

  test.each([
    "benchmark/runtime/capture.mjs",
    "benchmark/runtime/new-shared.mjs",
    "benchmark/src/synergy_bench/harnesses.py",
    "benchmark/test/test_matrix_docker.py",
  ])("shared or unknown input %s retains every native harness", (file) => {
    for (const variant of ["synergy", "pi", "codex", "opencode", "deepseek"])
      expect(taskSelected(native(variant), new Set(["benchmark"]), [file], false)).toBe(true)
  })
})

test("the actual catalog keeps Desktop validation separate from native coverage baselines", async () => {
  const tasks = await catalog()
  const workspaces: WorkspaceInput[] = [
    { directory: "apps/web", name: "web", dependencies: [], testDependencies: [] },
    { directory: "apps/desktop", name: "desktop", dependencies: [], testDependencies: ["web", "presets"] },
    { directory: "packages/local-runtime", name: "local-runtime", dependencies: [], testDependencies: [] },
    { directory: "packages/cli", name: "cli", dependencies: ["local-runtime"], testDependencies: [] },
    { directory: "packages/presets", name: "presets", dependencies: ["local-runtime"], testDependencies: [] },
    { directory: "packages/util", name: "util", dependencies: [], testDependencies: [] },
    { directory: "packages/harness", name: "harness", dependencies: [], testDependencies: [] },
    { directory: "packages/lsp", name: "lsp", dependencies: [], testDependencies: [] },
    { directory: "packages/formatter", name: "formatter", dependencies: [], testDependencies: [] },
  ]
  const plan = (changed: string[], mode: "affected" | "shadow" = "affected", leafTests: string[] = []) =>
    createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      changed,
      mode,
      tasks,
      baseWorkspaces: workspaces,
      headWorkspaces: workspaces,
      selectionChanges: { leafTests },
    })
  const web = plan(["apps/web/src/components/view.tsx"])
  for (const id of ["desktop", "windows-desktop", "web-integration"]) expect(web.selected).toContain(id)
  expect(web.selected).not.toContain("windows-native")
  expect(web.selected).not.toContain("macos-workspace")
  expect(web.selected.some((id) => id.startsWith("suite-packages-local-runtime"))).toBe(false)
  const native = plan(["packages/local-runtime/src/process/native-pty.ts"])
  for (const id of ["windows-native", "macos-workspace", "native-synergy"]) expect(native.selected).toContain(id)
  const baselines = tasks.filter(
    (entry) =>
      entry.kind === "suite" &&
      ["packages/local-runtime", "packages/cli", "packages/presets"].includes(entry.package ?? ""),
  )
  for (const suite of baselines) expect(native.selected).toContain(suite.id)
  for (const [file, required] of [
    ["packages/local-runtime/test/process/owned-process-windows.test.ts", ["windows-native", "macos-workspace"]],
    ["packages/cli/test/cli/data-files.test.ts", ["windows-native"]],
    ["packages/util/test/fs-lock.test.ts", ["windows-native"]],
    ["packages/lsp/test/lsp/owner-runtime.test.ts", ["windows-native", "macos-workspace"]],
    ["packages/formatter/test/format/formatter.test.ts", ["windows-native", "macos-workspace"]],
    ["packages/harness/test/session/snapshot-long-path.test.ts", ["windows-native", "macos-workspace"]],
    ["apps/desktop/test/windows-installer.test.ts", ["windows-desktop"]],
  ] as const) {
    const leaf = plan([file], "affected", [file])
    for (const id of required) expect(leaf.selected).toContain(id)
    if (required.some((id) => id !== "windows-desktop"))
      for (const suite of baselines) expect(leaf.selected).toContain(suite.id)
  }
  const shadow = plan(["apps/web/src/components/view.tsx"], "shadow")
  expect(shadow.proposed).toEqual(web.selected)
  expect(shadow.selected).toHaveLength(tasks.length)
})
