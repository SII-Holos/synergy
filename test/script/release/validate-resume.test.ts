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
      ".github/workflows/release.yml",
      "script/changelog.ts",
      "test/script/changelog.test.ts",
      "docs/operations/desktop-release.md",
      "packages/local-runtime/execution-host.Dockerfile",
      "packages/local-runtime/test/process/native-library.test.ts",
    ]),
  ).not.toThrow()
})

test("rejects changed product bytes and native or module build inputs", () => {
  for (const changed of [
    "packages/harness/src/index.ts",
    "packages/local-runtime/src/environment/entry.ts",
    "packages/local-runtime/src/test/owned-worker.ts",
    "packages/local-runtime/script/build-execution-host.ts",
    "script/release/shared/build/native-build-packages.ts",
    "script/release/shared/publish-modules.ts",
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
