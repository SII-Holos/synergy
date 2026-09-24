#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { buildCacheIdentity, buildCommands, filesIn, publishBuild, restoreBuild } from "./ci/artifacts"
import { catalog, changedFiles, OUTPUT, ROOT, workspaceInputs } from "./ci/catalog"
import { verifyCoverage } from "./ci/coverage"
import { verifyResults, type TaskResult } from "./ci/evidence"
import { createPlan, executionQueue, needsBuild, QUEUES, validatePlan, type Mode, type Plan } from "./ci/plan"
import { executeUnit } from "./ci/run"
import { policyIdentity, rolloutErrors, shadowEvidence, type ShadowEvidence } from "./ci/rollout"

const HELP = `Usage: bun script/ci.ts <plan|run|verify|prepare|restore|build-key|history|rollout-check> [options]
plan --base SHA --head SHA --sha SHA --mode full|shadow|affected|diagnostic --only task[,task] --package workspace --file package/test/file.test.ts
run --plan FILE --unit ID
verify --plan FILE --results DIRECTORY --jobs JSON
prepare / restore: produce or validate the input-addressed Linux build bundle.
build-key: resolve the cache identity on the runner that will build the bundle.
history: download full-run admission evidence from this repository's successful CI runs.
rollout-check --history DIRECTORY: require 20 matching full-run samples before affected admission.
Diagnostic plans never satisfy All checks passed. CI defaults to shadow mode.`

export async function policyDigest(root = ROOT) {
  return policyIdentity(
    await Promise.all(
      [
        "script/ci/plan.ts",
        "script/ci/catalog.ts",
        "script/ci/evidence.ts",
        "script/ci/coverage.ts",
        "script/ci/run.ts",
        "packages/testing/script/run.ts",
        "packages/testing/script/batches.ts",
        "script/coverage-exempt.json",
        "script/workspace-dependencies.ts",
        "script/workspace-manifest.ts",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    ),
  )
}

function revision(ref: string): string {
  return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ROOT })
    .toString()
    .trim()
}

async function readPlan(file: string): Promise<Plan> {
  const plan = JSON.parse(await readFile(file, "utf8")) as Plan
  validatePlan(plan)
  if (
    process.env.GITHUB_RUN_ID &&
    (plan.run !== process.env.GITHUB_RUN_ID || plan.attempt !== process.env.GITHUB_RUN_ATTEMPT)
  )
    throw new Error("Execution belongs to a different workflow attempt; rerun all jobs")
  if (revision("HEAD") !== plan.sha) throw new Error("Execution checkout differs from the planned commit")
  return plan
}

export function requiresBuild(plan: Plan) {
  return plan.tasks.some((task) => plan.selected.includes(task.id) && needsBuild(task))
}

async function history(directory: string): Promise<ShadowEvidence[]> {
  return Promise.all(
    (await filesIn(directory))
      .filter((file) => file.endsWith("shadow.json"))
      .map(async (file) => JSON.parse(await readFile(file, "utf8")) as ShadowEvidence),
  )
}

async function command(args: string[], cwd = ROOT) {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`CI preparation failed: ${args[0]}`)
}

async function fetchHistory(directory: string) {
  const repository = process.env.GITHUB_REPOSITORY ?? ""
  const token = process.env.GH_TOKEN
  if (!repository || !token) throw new Error("CI history requires repository-scoped read access")
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?status=completed&per_page=100`,
    { headers },
  )
  if (!response.ok) throw new Error(`Cannot read CI history: ${response.status}`)
  const data = (await response.json()) as {
    workflow_runs: Array<{
      id: number
      conclusion: string
      event: string
      head_branch: string
      head_sha: string
      run_attempt: number
    }>
  }
  await mkdir(directory, { recursive: true })
  const candidates = data.workflow_runs
    .filter((run) => ["success", "failure"].includes(run.conclusion) && ["push", "pull_request"].includes(run.event))
    .slice(0, 60)
  async function download(run: (typeof candidates)[number]) {
    const artifacts = await fetch(
      `https://api.github.com/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
      { headers },
    )
    if (!artifacts.ok) return
    const listing = (await artifacts.json()) as { artifacts: Array<{ id: number; name: string; expired: boolean }> }
    const artifact = listing.artifacts.find(
      (entry) => entry.name === `ci-admission-${run.run_attempt}` && !entry.expired,
    )
    if (!artifact) return
    const destination = path.join(directory, String(run.id))
    await command([
      "gh",
      "run",
      "download",
      String(run.id),
      "--repo",
      repository,
      "--name",
      artifact.name,
      "--dir",
      destination,
    ])
    const file = path.join(destination, "shadow.json")
    const sample = (await Bun.file(file).json()) as ShadowEvidence
    if (sample.run !== String(run.id) || (run.event === "push" && sample.sha !== run.head_sha))
      throw new Error("CI admission artifact does not match its producing run")
  }
  for (let index = 0; index < candidates.length; index += 6)
    await Promise.all(candidates.slice(index, index + 6).map(download))
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean" },
      base: { type: "string" },
      head: { type: "string" },
      sha: { type: "string" },
      mode: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      unit: { type: "string" },
      only: { type: "string" },
      package: { type: "string" },
      file: { type: "string" },
      results: { type: "string" },
      jobs: { type: "string" },
      history: { type: "string" },
    },
  })
  if (values.help || !positionals.length) {
    console.log(HELP)
    return
  }
  const operation = positionals[0]
  const historyRoot = values.history ?? path.join(ROOT, OUTPUT, "history")
  if (operation === "history") {
    await fetchHistory(historyRoot)
    return
  }
  if (operation === "rollout-check") {
    const errors = rolloutErrors(await history(historyRoot), await policyDigest())
    if (errors.length) throw new Error(errors.join("\n"))
    console.log("Affected admission evidence passed")
    return
  }
  if (operation === "plan") {
    const settings = (await Bun.file(path.join(ROOT, "script/ci/rollout.json")).json()) as { mode: Mode }
    const event = process.env.GITHUB_EVENT_NAME
    const mode = (values.mode ?? (["push", "schedule"].includes(event ?? "") ? "full" : settings.mode)) as Mode
    if (!["full", "shadow", "affected", "diagnostic"].includes(mode)) throw new Error("Unknown CI mode")
    if (mode === "affected") {
      const errors = rolloutErrors(await history(historyRoot), await policyDigest())
      if (errors.length) throw new Error(errors.join("\n"))
    }
    const sha = revision(values.sha ?? "HEAD")
    const head = revision(values.head ?? sha)
    const base = revision(values.base ?? `${head}^`)
    const tasks = await catalog()
    const only = new Set(values.only?.split(",").filter(Boolean) ?? [])
    if (values.package) {
      const matches = tasks.filter(
        (task) =>
          task.package === values.package ||
          (values.package === "benchmark" && task.kind.startsWith("benchmark-") && task.kind !== "benchmark-prepare"),
      )
      if (!matches.length) throw new Error("Unknown diagnostic package")
      matches.forEach((task) => only.add(task.id))
    }
    if (values.file) {
      const file = values.file.replaceAll("\\", "/")
      const matches = file.endsWith(".py")
        ? tasks.filter((task) => task.files?.includes(file) && task.kind !== "benchmark-pure")
        : tasks
            .filter(
              (task) =>
                task.kind === "suite" &&
                task.package &&
                file.startsWith(task.package + "/") &&
                task.files?.includes(file.slice(task.package.length + 1)),
            )
            .slice(0, 1)
      if (!matches.length && file.endsWith(".py"))
        matches.push(...tasks.filter((task) => task.kind === "benchmark-pure" && task.files?.includes(file)))
      if (!matches.length) throw new Error("Diagnostic file is not in the discovered test inventory")
      for (const task of matches) {
        const id = `diagnostic-${task.id}`
        tasks.push(
          file.endsWith(".py")
            ? { ...task, id, diagnosticFiles: [file] }
            : { ...task, id, partition: undefined, files: [file.slice(task.package!.length + 1)], variant: "file" },
        )
        only.add(id)
      }
    }
    if ((only.size || values.file || values.package) && mode !== "diagnostic")
      throw new Error("Task selectors require diagnostic mode")
    if (mode === "diagnostic" && !only.size) throw new Error("Select a diagnostic task, package, or file")
    const [baseWorkspaces, headWorkspaces] = await Promise.all([
      workspaceInputs(ROOT, base),
      workspaceInputs(ROOT, head),
    ])
    const plan = createPlan({
      base,
      head,
      sha,
      run: process.env.GITHUB_RUN_ID ?? "local",
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
      mode,
      changed: changedFiles(ROOT, base, head),
      baseWorkspaces,
      headWorkspaces,
      tasks,
      only: [...only],
    })
    const output = values.output ?? path.join(ROOT, OUTPUT, "plan.json")
    await Bun.write(output, JSON.stringify(plan, null, 2))
    const sandbox = plan.tasks.some(
      (task) => plan.selected.includes(task.id) && ["sandbox", "artifacts"].includes(task.kind),
    )
    process.env.SYNERGY_CI_SANDBOX_BUNDLE = sandbox ? "1" : "0"
    const outputs: Record<string, string> = {
      sha,
      mode,
      build: String(requiresBuild(plan)),
      sandbox: sandbox ? "1" : "0",
      benchmark: String(plan.selected.includes("benchmark-prepare")),
    }
    const selectedTasks = plan.tasks.filter((task) => plan.selected.includes(task.id))
    for (const pool of QUEUES) {
      outputs[pool] = JSON.stringify(
        plan.units
          .filter((unit) => executionQueue(unit, selectedTasks) === pool)
          .map((unit) => ({ ...unit, postgres: plan.tasks.find((task) => task.id === unit.tasks[0])?.variant ?? "" })),
      )
      outputs[`${pool}_count`] = String(
        plan.units.filter((unit) => executionQueue(unit, selectedTasks) === pool).length,
      )
    }
    outputs.diagnostic = JSON.stringify(
      plan.units.map((unit) => ({
        ...unit,
        os: unit.pool === "windows" ? "windows-latest" : unit.pool === "macos" ? "macos-15" : "ubuntu-24.04",
        postgres:
          unit.pool === "postgres" ? `postgres:${plan.tasks.find((task) => task.id === unit.tasks[0])!.variant}` : "",
      })),
    )
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      )
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### CI plan: ${mode}\n\nSelected ${plan.selected.length}; affected proposal ${plan.proposed.length}.\n\n| Task | Reason |\n|---|---|\n${plan.tasks.map((task) => `| ${task.id} | ${plan.reasons[task.id]} |`).join("\n")}\n`,
      )
    console.log(
      JSON.stringify({
        output,
        digest: plan.digest,
        mode,
        selected: plan.selected.length,
        proposed: plan.proposed.length,
        units: plan.units.length,
      }),
    )
    return
  }
  if (operation === "build-key") {
    const key = await buildCacheIdentity()
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `key=${key}\n`)
    console.log(key)
    return
  }
  if (operation === "prepare") {
    await command([process.execPath, "packages/runtime-local/script/build-watcher.ts"])
    for (const recipe of buildCommands()) await command(recipe.args, recipe.cwd)
    if (process.env.SYNERGY_CI_SANDBOX_BUNDLE === "1") {
      await command([
        "cargo",
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        "packages/runtime-local/src/sandbox/helper-linux/Cargo.toml",
      ])
      await mkdir(path.join(ROOT, "packages/runtime-local/sandbox-assets/linux-x64"), { recursive: true })
      await Bun.write(
        path.join(ROOT, "packages/runtime-local/sandbox-assets/linux-x64/synergy-sandbox-linux"),
        Bun.file(
          path.join(ROOT, "packages/runtime-local/src/sandbox/helper-linux/target/release/synergy-sandbox-linux"),
        ),
      )
      await command(["chmod", "+x", "packages/runtime-local/sandbox-assets/linux-x64/synergy-sandbox-linux"])
    }
    await publishBuild()
    return
  }
  if (operation === "restore") {
    await restoreBuild()
    return
  }
  const plan = await readPlan(values.plan ?? path.join(ROOT, OUTPUT, "plan.json"))
  if (operation === "run") {
    if (!values.unit) throw new Error("Execution requires --unit")
    const failures = await executeUnit(plan, values.unit)
    if (failures.length) throw new Error(`CI tasks failed: ${failures.join(", ")}`)
    return
  }
  if (operation !== "verify") throw new Error(`Unknown CI operation: ${operation}`)
  const resultsRoot = values.results ?? path.join(ROOT, OUTPUT, "results")
  const results = await Promise.all(
    (await filesIn(resultsRoot))
      .filter((file) => file.endsWith("/result.json"))
      .map(async (file) => JSON.parse(await readFile(file, "utf8")) as TaskResult),
  )
  const needs = JSON.parse(values.jobs ?? process.env.CI_NEEDS ?? "{}") as Record<string, { result: string }>
  const expected = new Set([
    "plan",
    ...plan.units.map((unit) =>
      executionQueue(
        unit,
        plan.tasks.filter((task) => plan.selected.includes(task.id)),
      ),
    ),
    ...(requiresBuild(plan) ? ["prepare"] : []),
    ...(plan.selected.includes("benchmark-prepare") ? ["benchmark-prepare"] : []),
  ])
  const jobs = [...expected].map((id) => needs[id]?.result ?? "missing")
  const errors = verifyResults(plan, results, jobs)
  const coverage = errors.length ? undefined : await verifyCoverage(ROOT, resultsRoot, plan, results)
  errors.push(...(coverage?.errors ?? []))
  const evidence = shadowEvidence(plan, results, errors.length === 0, await policyDigest())
  await Bun.write(path.join(ROOT, OUTPUT, "admission/shadow.json"), JSON.stringify(evidence, null, 2))
  await Bun.write(
    path.join(ROOT, OUTPUT, "summary.json"),
    JSON.stringify(
      {
        plan: plan.digest,
        errors,
        coverage,
        evidence,
        reports: results.map((result) => ({
          task: result.task,
          seconds: (Date.parse(result.completed) - Date.parse(result.started)) / 1000,
          steps: result.steps,
        })),
      },
      null,
      2,
    ),
  )
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Verification: ${errors.length ? "failed" : "passed"}\n\nRunner task time: ${(evidence.taskSeconds / 60).toFixed(1)} minutes.\n\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
    )
  if (errors.length) throw new Error(errors.join("\n"))
  console.log("All planned checks passed, with verified report identities and coverage")
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
