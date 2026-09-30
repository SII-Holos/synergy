#!/usr/bin/env bun
import {
  distributionBuildIdentity,
  distributionCommands,
  publishDistribution,
  rebindDistribution,
} from "./ci/distributions"
import { createIsolatedTestEnv } from "../packages/testing/src/env"
import { verifyScenarios } from "./ci/junit"
import { parseArgs } from "node:util"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { buildCacheIdentity, buildCommands, publishBuild, restoreBuild } from "./ci/artifacts"
import { catalog, changedFiles, OUTPUT, ROOT, workspaceInputs } from "./ci/catalog"
import { verifyCoverage } from "./ci/coverage"
import { latestResults, readResults, verifyResults } from "./ci/evidence"
import { downloadInput, workflowExecutions } from "./ci/github"
import { createPlan, executionQueue, needsBuild, QUEUES, validatePlan, type Mode, type Plan } from "./ci/plan"
import { executeUnit } from "./ci/run"
import { policyIdentity, shadowEvidence } from "./ci/rollout"

const HELP = `Usage: bun script/ci.ts <plan|run|verify|prepare|restore|build-key|distribution-key|prepare-distributions> [options]
plan --base SHA --head SHA --sha SHA --mode full|shadow|affected|diagnostic --only task[,task] --package workspace --file package/test/file.test.ts
run --plan FILE --unit ID
verify --plan FILE --results DIRECTORY --jobs JSON
prepare / restore: produce or validate the input-addressed Linux build bundle.
build-key: resolve the cache identity on the runner that will build the bundle.
prepare-distributions --profile core|full: produce only the selected distribution.
distribution-key --profile core|full: resolve the distribution cache identity.
Diagnostic plans never satisfy All checks passed. PRs default to affected mode; shared or unknown inputs select full verification.`

export async function policyDigest(root = ROOT) {
  return policyIdentity(
    await Promise.all(
      ["script/ci/selection.ts", "script/ci/inputs.ts", "script/workspace-dependencies.ts"].map((file) =>
        readFile(path.join(root, file), "utf8"),
      ),
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
    (plan.run !== process.env.GITHUB_RUN_ID || Number(plan.attempt) > Number(process.env.GITHUB_RUN_ATTEMPT))
  )
    throw new Error("Execution belongs to a different workflow run or future plan attempt")
  if (revision("HEAD") !== plan.sha) throw new Error("Execution checkout differs from the planned commit")
  return plan
}

export function requiresBuild(plan: Plan) {
  return plan.tasks.some((task) => plan.selected.includes(task.id) && needsBuild(task))
}

async function command(args: string[], cwd = ROOT) {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`CI preparation failed: ${args[0]}`)
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
      profile: { type: "string" },
      cached: { type: "boolean" },
    },
  })
  if (values.help || !positionals.length) {
    console.log(HELP)
    return
  }
  const operation = positionals[0]
  if (operation === "plan") {
    const settings = (await Bun.file(path.join(ROOT, "script/ci/rollout.json")).json()) as { mode: Mode }
    const event = process.env.GITHUB_EVENT_NAME
    const mode = (values.mode ?? (["push", "schedule"].includes(event ?? "") ? "full" : settings.mode)) as Mode
    if (!["full", "shadow", "affected", "diagnostic"].includes(mode)) throw new Error("Unknown CI mode")
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
    const { taskInputs } = await import("./ci/inputs")
    const [baseInputs, headInputs] = await Promise.all([
      taskInputs(ROOT, base, tasks, baseWorkspaces),
      taskInputs(ROOT, head, tasks, headWorkspaces),
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
      baseInputs,
      headInputs,
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
      attempt: plan.attempt,
      core: String(plan.tasks.some((task) => plan.selected.includes(task.id) && task.profile === "core")),
      full: String(plan.tasks.some((task) => plan.selected.includes(task.id) && task.profile === "full")),
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
    const native = async () => {
      await Promise.all([
        command([process.execPath, "packages/local-runtime/script/build-watcher.ts"]),
        command([process.execPath, "packages/local-runtime/script/build-pty.ts"]),
      ])
      if (process.env.SYNERGY_CI_SANDBOX_BUNDLE === "1") {
        await command([
          "cargo",
          "build",
          "--locked",
          "--release",
          "--manifest-path",
          "packages/local-runtime/src/sandbox/helper-linux/Cargo.toml",
        ])
        await mkdir(path.join(ROOT, "packages/local-runtime/sandbox-assets/linux-x64"), { recursive: true })
        await Bun.write(
          path.join(ROOT, "packages/local-runtime/sandbox-assets/linux-x64/synergy-sandbox-linux"),
          Bun.file(
            path.join(ROOT, "packages/local-runtime/src/sandbox/helper-linux/target/release/synergy-sandbox-linux"),
          ),
        )
        await command(["chmod", "+x", "packages/local-runtime/sandbox-assets/linux-x64/synergy-sandbox-linux"])
      }
    }
    const web = async () => {
      for (const recipe of buildCommands()) await command(recipe.args, recipe.cwd)
      if (process.env.SYNERGY_CI_WEB_BUILD === "true")
        await command([process.execPath, "run", "--cwd", "apps/web", "build", "--manifest"])
    }
    const prepared = await Promise.allSettled([native(), web()])
    const failed = prepared.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    await publishBuild()
    return
  }
  if (operation === "restore") {
    await restoreBuild()
    return
  }
  const plan = await readPlan(values.plan ?? path.join(ROOT, OUTPUT, "plan.json"))
  if (operation === "distribution-key") {
    if (values.profile !== "core" && values.profile !== "full") throw new Error("A distribution profile is required")
    const key = await distributionBuildIdentity(ROOT, plan, values.profile)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `key=${key}\n`)
    console.log(key)
    return
  }
  if (operation === "prepare-distributions") {
    const profiles = [
      ...new Set(
        plan.tasks
          .filter((task) => plan.selected.includes(task.id))
          .map((task) => task.profile)
          .filter((profile): profile is "core" | "full" => !!profile),
      ),
    ]
    if (values.profile && !profiles.includes(values.profile as "core" | "full"))
      throw new Error("Unknown or unselected distribution profile")
    for (const profile of profiles.filter((profile) => !values.profile || values.profile === profile)) {
      const isolated = await createIsolatedTestEnv()
      try {
        if (values.cached) await rebindDistribution(ROOT, plan, profile)
        else {
          for (const recipe of distributionCommands(profile, ROOT)) {
            const child = Bun.spawn(recipe.args, {
              cwd: ROOT,
              stdout: "inherit",
              stderr: "inherit",
              env: {
                ...isolated.env,
                SYNERGY_HOME: path.join(isolated.env.SYNERGY_TEST_ROOT!, "build-home"),
                SYNERGY_BUILD_TARGETS: "linux-x64",
                SYNERGY_REQUIRE_SANDBOX_ASSETS: "1",
                SYNERGY_CI_WEB_MANIFEST: "1",
                HUSKY: "0",
              },
            })
            if (await child.exited) throw new Error(`Distribution preparation failed: ${recipe.name}`)
          }
          await publishDistribution(ROOT, plan, profile)
        }
        await command([
          "tar",
          "-I",
          "zstd -T2 -3",
          "-cf",
          `.artifacts/ci/distributions/${profile}.tar.zst`,
          "-C",
          ".artifacts/ci/distributions",
          profile,
        ])
      } finally {
        await isolated.dispose()
      }
    }
    return
  }
  if (operation === "run") {
    if (!values.unit) throw new Error("Execution requires --unit")
    const failures = await executeUnit(
      plan,
      values.unit,
      ROOT,
      process.env.GITHUB_RUN_ID && plan.mode !== "diagnostic"
        ? (profile) => downloadInput(plan, ROOT, profile)
        : undefined,
    )
    if (failures.length) throw new Error(`CI tasks failed: ${failures.join(", ")}`)
    return
  }
  if (operation !== "verify") throw new Error(`Unknown CI operation: ${operation}`)
  const resultsRoot = values.results ?? path.join(ROOT, OUTPUT, "results")
  const history = await readResults(resultsRoot)
  const executions = process.env.GITHUB_RUN_ID ? await workflowExecutions(plan) : undefined
  const results = latestResults(plan, history, executions)
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
    ...new Set(
      plan.tasks
        .filter((task) => plan.selected.includes(task.id) && task.profile)
        .map((task) => `prepare-${task.profile}`),
    ),
  ])
  const jobs = [...expected].map((id) => needs[id]?.result ?? "missing")
  const errors = verifyResults(plan, history, jobs, executions)
  if (!errors.length) errors.push(...(await verifyScenarios(resultsRoot, plan, results)))
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
