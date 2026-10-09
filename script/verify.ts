#!/usr/bin/env bun
import path from "node:path"
import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"
import { rm } from "node:fs/promises"
import { catalog, ROOT, workspaceInputs } from "./ci/catalog"
import { RevisionSnapshot } from "./ci/revision"
import { selectionInputs, taskInputs } from "./ci/inputs"
import { createPlan } from "./ci/plan"
import { documentation } from "./ci/selection"
import { filesIn } from "./ci/artifacts"
import { loadManifest, matchesExempt, parseLcov } from "./coverage-check"
import { runGates } from "./gates"
import { WorkingSnapshot, changedInputs, missingMeasurements } from "./verification"
import { createIsolatedTestEnv } from "../packages/testing/src/env"

const HELP = `Usage: bun run verify <plan|local|coverage|pre-push> [options]
plan [--base origin/dev]: explain CI selection for the complete working tree.
local [--base origin/dev] --test path/to/test.test.ts (repeatable): selected tests, new-source measurements and local static checks.
coverage --package packages/name (repeatable): fresh complete package coverage.
pre-push: required static checks, reusing only identical local inputs.
Reports: .artifacts/verify/report.json. Local reports cannot satisfy CI.
No implicit full test suite. Choose behavior tests explicitly when code changes.`

async function command(args: string[], env = process.env, cwd = ROOT) {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  if (await child.exited) throw new Error(`Verification command failed: ${args.join(" ")}`)
}

export async function localPlan(root: string, ref: string) {
  const base = execFileSync("git", ["merge-base", "HEAD", ref], { cwd: root, encoding: "utf8" }).trim()
  const before = new RevisionSnapshot(root, base)
  const snapshot = new WorkingSnapshot(root)
  const changed = changedInputs(root, base, snapshot)
  const [baseWorkspaces, headWorkspaces, tasks] = await Promise.all([
    workspaceInputs(before),
    workspaceInputs(snapshot),
    catalog(root),
  ])
  const [changes, baseInputs, headInputs] = await Promise.all([
    selectionInputs(before, snapshot, changed, baseWorkspaces, headWorkspaces),
    taskInputs(before, tasks, baseWorkspaces),
    taskInputs(snapshot, tasks, headWorkspaces),
  ])
  const forecast = createPlan({
    base,
    head: snapshot.digest,
    sha: snapshot.digest,
    run: "local-preview",
    mode: "affected",
    changed,
    baseWorkspaces,
    headWorkspaces,
    baseInputs,
    headInputs,
    selectionChanges: changes,
    tasks,
  })
  const manifest = await loadManifest(root)
  const old = JSON.parse(before.required("script/coverage-exempt.json")) as typeof manifest
  const measurements = snapshot.files.filter((file) => {
    const owner = headWorkspaces.find((entry) => file.startsWith(entry.directory + "/src/"))?.directory
    if (!owner || !/\.tsx?$/.test(file) || !manifest.packages[owner]) return false
    const relative = file.slice(owner.length + 1)
    if (matchesExempt(relative, manifest.packages[owner]!.exempt)) return false
    return !before.inventory.has(file) || !!matchesExempt(relative, old.packages[owner]?.exempt ?? [])
  })
  return {
    snapshot,
    headWorkspaces,
    measurements,
    manifest,
    report: {
      version: 1,
      kind: "local-verification",
      base,
      input: snapshot.digest,
      changed,
      ci: {
        status: "pending",
        selected: forecast.selected.length,
        total: tasks.length,
        reasons: forecast.reasons,
        fullTriggers: forecast.fullTriggers ?? [],
      },
      measurements,
      tests: [] as string[],
      status: "planned",
      errors: [] as string[],
    },
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      base: { type: "string", default: "origin/dev" },
      test: { type: "string", multiple: true },
      package: { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  })
  if (values.help || !positionals.length) {
    console.log(HELP)
    return
  }
  const operation = positionals[0]
  if (positionals.length !== 1 || !["plan", "local", "coverage", "pre-push"].includes(operation!)) throw new Error(HELP)
  await command([process.execPath, "script/check-bun-version.ts"])
  if (operation === "pre-push") {
    const result = await runGates("pre-push")
    for (const failure of result.failures) console.error(`${failure.gate}: ${failure.stderr}`)
    if (result.failures.length) process.exitCode = 1
    return
  }
  if (operation === "coverage") {
    if (!values.package?.length || values.test?.length) throw new Error("Select complete packages with --package")
    await command([process.execPath, "turbo", "build", "--filter=@ericsanchezok/synergy-plugin"])
    await command([
      process.execPath,
      "script/coverage-check.ts",
      ...values.package.flatMap((owner) => ["--package", owner]),
    ])
    return
  }
  if (values.package?.length) throw new Error("--package requires coverage mode")
  const { snapshot, headWorkspaces, measurements, manifest, report } = await localPlan(ROOT, values.base!)
  const output = path.join(ROOT, ".artifacts/verify/report.json")
  try {
    if (operation === "plan") {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    const tests = [
      ...new Set(
        values.test ??
          report.changed.filter(
            (file) => /(?:^|\/)test\/.*\.(?:test|spec)\.tsx?$/.test(file) && snapshot.inventory.has(file),
          ),
      ),
    ].sort()
    if (!tests.length && report.changed.some((file) => !documentation(file)))
      throw new Error("Choose relevant behavior tests with --test; no full suite was started")
    const groups = new Map<string, string[]>()
    for (const file of tests) {
      if (!snapshot.inventory.has(file) || !/(?:^|\/)test\/.*\.(?:test|spec)\.tsx?$/.test(file))
        throw new Error(`Unknown test file: ${file}`)
      const owner = headWorkspaces.find((entry) => file.startsWith(entry.directory + "/"))?.directory ?? "."
      if (owner === "." && !file.startsWith("test/")) throw new Error(`No test owner: ${file}`)
      groups.set(owner, [...(groups.get(owner) ?? []), owner === "." ? file : file.slice(owner.length + 1)])
    }
    report.tests = tests
    for (const file of measurements) {
      const owner = headWorkspaces.find((entry) => file.startsWith(entry.directory + "/"))!.directory
      if (!groups.has(owner)) throw new Error(`Select a behavioral coverage test for new source: ${file}`)
    }
    if ([...groups.keys()].some((owner) => ["apps/web", "packages/ui"].includes(owner)))
      await command([process.execPath, "turbo", "build", "--filter=@ericsanchezok/synergy-plugin"])
    for (const [owner, files] of groups) {
      try {
        if (owner === ".") {
          const isolated = await createIsolatedTestEnv()
          try {
            await command([process.execPath, "test", "--config", "/dev/null", ...files], isolated.env)
          } finally {
            await isolated.dispose()
          }
          continue
        }
        const config = manifest.packages[owner]
        if (!config) throw new Error(`No coverage runner for ${owner}`)
        await rm(path.join(ROOT, owner, "coverage"), { recursive: true, force: true })
        await command(
          ["sh", "-c", config.command],
          { ...process.env, SYNERGY_TEST_FILES: JSON.stringify(files), LC_ALL: "C" },
          path.join(ROOT, owner),
        )
        const records = (
          await Promise.all(
            (await filesIn(path.join(ROOT, owner, "coverage")))
              .filter((file) => file.endsWith("/lcov.info"))
              .map(async (file) => parseLcov(await Bun.file(file).text())),
          )
        ).flat()
        const missing = missingMeasurements(
          measurements.filter((file) => file.startsWith(owner + "/")).map((file) => file.slice(owner.length + 1)),
          records,
          config.exempt,
        )
        if (missing.length) throw new Error(`Unmeasured new source in ${owner}: ${missing.join(", ")}`)
      } catch (error) {
        report.errors.push(String(error))
      }
    }
    const gates = await runGates("local")
    report.errors.push(...gates.failures.map((failure) => `${failure.gate}: ${failure.stderr}`))
    if (
      report.changed.some((file) =>
        /^(apps\/web\/(?:vite\.config|src\/(?:app|index|entry))|packages\/ui\/package\.json)/.test(file),
      )
    ) {
      try {
        await command([process.execPath, "run", "--cwd", "apps/web", "build"])
        await command([process.execPath, "test", "--cwd", "apps/web", "test/testing/browser-crypto-contract.test.ts"])
        await command([process.execPath, "apps/web/script/private-http-smoke.ts"])
      } catch (error) {
        report.errors.push(String(error))
      }
    }
    if (new WorkingSnapshot(ROOT).digest !== snapshot.digest)
      report.errors.push("Working inputs changed during verification; run again")
    report.status = report.errors.length ? "failed" : "local-passed"
    if (report.errors.length) throw new Error(report.errors.join("\n"))
    console.log(
      "Selected local verification passed. Complete package coverage and platform checks remain pending in CI.",
    )
  } catch (error) {
    report.status = "failed"
    if (!report.errors.length) report.errors.push(String(error))
    throw error
  } finally {
    await Bun.write(output, JSON.stringify(report, null, 2) + "\n")
  }
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
