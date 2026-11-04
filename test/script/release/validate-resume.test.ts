import { expect, test } from "bun:test"
import { assertReleaseResumeSource } from "../../../script/release/validate-resume"

const run = {
  path: ".github/workflows/release.yml",
  event: "workflow_dispatch",
  status: "completed",
  head_branch: "dev",
  head_sha: "source-revision",
}
const jobs = [
  { name: "Build Stable Native Assets / Linux x64 native assets", conclusion: "success" },
  { name: "Publish Stable Candidate", conclusion: "failure" },
]

test("resumes a failed candidate with verified native artifacts and release-only corrections", () => {
  expect(() =>
    assertReleaseResumeSource(run, jobs, [
      "script/release/shared/runtime.ts",
      "script/release/shared/module-seed.ts",
      "script/release/shared/seed-payload.ts",
      "script/release/shared/publish-modules.ts",
      "script/release/shared/publish-generic.ts",
      "script/release/nodes/publish-synergy-candidate.ts",
      "script/release/nodes/package-binary-assets.ts",
      "script/release/dev.ts",
      ".github/workflows/release.yml",
      ".github/workflows/ci.yml",
      "script/ci.ts",
      "script/changelog.ts",
      "test/script/changelog.test.ts",
      "docs/operations/desktop-release.md",
      "packages/local-runtime/execution-host.Dockerfile",
      "packages/local-runtime/test/process/native-library.test.ts",
      "benchmark/test/test_prepare.py",
    ]),
  ).not.toThrow()
})

test("rejects changed product bytes and native or module build inputs", () => {
  for (const changed of [
    "packages/harness/src/index.ts",
    "packages/local-runtime/src/environment/entry.ts",
    "packages/local-runtime/src/test/owned-worker.ts",
    "packages/local-runtime/script/build-execution-host.ts",
    "benchmark/src/synergy_bench/prepare.py",
    "benchmark/runtime/entry.ts",
    "script/release/shared/build/native-build-packages.ts",
    "script/pack-workspace.ts",
    "script/build-workspace.ts",
    "script/release/shared/native-package.ts",
    "script/release/shared/build-runtime.ts",
    ".github/workflows/build-helpers.yml",
    "bun.lock",
  ])
    expect(() => assertReleaseResumeSource(run, jobs, [changed])).toThrow("product or build changes")
})

test("rejects unrelated, unfinished, or unsuccessful native runs", () => {
  expect(() => assertReleaseResumeSource({ ...run, path: ".github/workflows/ci.yml" }, jobs, [])).toThrow("Release run")
  expect(() => assertReleaseResumeSource({ ...run, status: "in_progress" }, jobs, [])).toThrow("Release run")
  expect(() => assertReleaseResumeSource({ ...run, head_branch: "topic" }, jobs, [])).toThrow("Release run")
  expect(() => assertReleaseResumeSource(run, [], [])).toThrow("native asset jobs")
  expect(() => assertReleaseResumeSource(run, [{ ...jobs[0]!, conclusion: "failure" }], [])).toThrow(
    "native asset jobs",
  )
})
