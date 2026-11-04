#!/usr/bin/env bun
import { $ } from "bun"
import { currentRepo } from "../shared/current-repo"

interface ResumeRun {
  path: string
  event: string
  status: string
  head_branch: string
  head_sha: string
}

interface ResumeJob {
  name: string
  conclusion: string | null
}

const recoverableFiles = new Set([
  ".github/workflows/release.yml",
  "script/changelog.ts",
  "script/release/stable-start.ts",
  "script/release/dev.ts",
  "script/release/stable-complete.ts",
  "script/release/shared/runtime.ts",
  "script/release/shared/module-seed.ts",
  "script/release/shared/seed-payload.ts",
  "script/release/shared/publish-generic.ts",
  "script/release/shared/publish-modules.ts",
  "script/release/nodes/publish-synergy-candidate.ts",
  "script/release/nodes/package-binary-assets.ts",
  "script/release/validate-resume.ts",
  "packages/local-runtime/execution-host.Dockerfile",
])

export function assertReleaseResumeSource(run: ResumeRun, jobs: ResumeJob[], changed: string[]) {
  if (
    run.path !== ".github/workflows/release.yml" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.head_branch !== "dev"
  )
    throw new Error("Resume source must be a completed product Release run from dev")
  const native = jobs.filter((job) => job.name.startsWith("Build Stable Native Assets / "))
  if (!native.length || native.some((job) => job.conclusion !== "success"))
    throw new Error("Resume source must have successful native asset jobs")
  const productChanges = changed.filter(
    (file) =>
      !recoverableFiles.has(file) &&
      !["docs/", "test/", "benchmark/test/", ".synergy/skill/"].some((prefix) => file.startsWith(prefix)) &&
      !/^(?:packages|apps)\/[^/]+\/test\//.test(file),
  )
  if (productChanges.length)
    throw new Error(`Cannot resume after product or build changes: ${productChanges.join(", ")}`)
}

export async function validateReleaseResume(version?: string, runID?: string) {
  if (!version && !runID) return
  if (!version || !runID || !/^\d+$/.test(runID))
    throw new Error("Resume requires both version and a numeric native_run_id")
  const repo = await currentRepo()
  const run = (await $`gh api /repos/${repo}/actions/runs/${runID}`.json()) as ResumeRun
  const jobLines =
    await $`gh api --paginate /repos/${repo}/actions/runs/${runID}/jobs --jq '.jobs[] | {name, conclusion}'`.text()
  const jobs = jobLines
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResumeJob)
  const ancestor = await $`git merge-base --is-ancestor ${run.head_sha} HEAD`.nothrow().quiet()
  if (ancestor.exitCode !== 0) throw new Error("Resume source must be an ancestor of the current revision")
  const changed = (await $`git diff --name-only ${run.head_sha} HEAD`.text()).split("\n").filter(Boolean)
  assertReleaseResumeSource(run, jobs, changed)
  console.log(`Validated unchanged product source and native artifacts for v${version}`)
}

if (import.meta.main)
  await validateReleaseResume(process.env.SYNERGY_RELEASE_VERSION?.trim(), process.env.SYNERGY_NATIVE_RUN_ID?.trim())
