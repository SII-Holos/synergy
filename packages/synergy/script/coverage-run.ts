#!/usr/bin/env bun

/**
 * Synergy coverage runner. Mirrors the packages/app and packages/ui
 * orchestrators: one main batch runs the whole suite (single-process
 * semantics, so per-file lcov totals stay consistent) while a small set of
 * files that are flaky only under a full shared-process run execute in their
 * own isolated processes. Each batch writes lcov under coverage/shards/<n>/,
 * which script/coverage-check.ts merges with union semantics.
 */

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

import { createIsolatedTestEnv } from "./test-env"
const packageRoot = path.resolve(import.meta.dir, "..")

/**
 * Test files that fail only when the full suite shares one run. Each passes
 * in isolation; the failure modes are load- or state-sensitive:
 * - standalone Bun.build fixtures (embedding, svg-raster) hit
 *   "Unexpected reading file" on the transformers runtime under a full run;
 * - nav-global-routes asserts home-scope completion counters that sibling
 *   files can mutate;
 * - openai-image-gen's global fetch mock races with sibling fetch mocks;
 * - auto-expand mocks 15 module functions and drives the real tool scheduler
 *   and session store, so a single shared-process run with failing sibling
 *   fixtures (plugin registry, network) settles its parts as errors.
 * - holos/proxy/registry/retry/import/catalog/MCP-OAuth suites start
 *   local servers or assert network timing and flake under a full shared
 *   process on CI (see postmortem 0001 coverage failures); each passes in
 *   its own process.
 * - email/imap (mailparser parsing, config error propagation, IMAP truncation)
 *   and channel host / managed-project-ownership assert module-level email and
 *   channel state that sibling files can pollute under a full shared process;
 *   each passes in its own process (verified 2026-09-03 after repeated
 *   identical CI coverage failures on unrelated branches).
 * - library/database, library/experience-recall, channel/clarus-* and
 *   daemon/* suites assert module-level SQLite/vec, Clarus project, and
 *   managed-service env state that sibling files pollute under a full shared
 *   process; each passes in its own process (verified 2026-09-04 at pristine
 *   HEAD: the same shard-0 signature fails with or without the enforcement
 *   sandbox change set, and isolated reruns are green).
 * - test/cli/daemon-entry mock-modules src/server/runtime.ts; its own header
 *   documents that under the single-process coverage run the mock leaks into
 *   sibling files, and the startup assertion itself flakes under full-suite
 *   load on CI. Passes in its own process with coverage (verified 2026-09-04).
 */
export const ISOLATED_COVERAGE_FILES: ReadonlySet<string> = new Set([
  "test/vector/embedding-standalone.test.ts",
  "test/channel/svg-raster-standalone.test.ts",
  "test/server/nav-global-routes.test.ts",
  "test/tool/openai-image-gen.test.ts",
  "test/tool/auto-expand.test.ts",
  "test/holos/runtime.test.ts",
  "test/server/plugin-official-install.test.ts",
  "test/server/plugin-registry-routes.test.ts",
  "test/server/skill-route.test.ts",
  "test/config/import.test.ts",
  "test/provider/proxy.test.ts",
  "test/session/retry.test.ts",
  "test/provider/catalog-stability.test.ts",
  "test/plugin/mcp-declarative-oauth.test.ts",
  "test/email/imap.test.ts",
  "test/channel/host.test.ts",
  "test/channel/managed-project-ownership.test.ts",
  "test/channel/clarus-assignment.test.ts",
  "test/cli/daemon-entry.test.ts",
  "test/channel/clarus-invite-accept.test.ts",
  "test/daemon/observe.test.ts",
  "test/daemon/spec.test.ts",
  "test/library/database.test.ts",
  "test/library/experience-recall.test.ts",
])

export interface CoverageBatches {
  main: string[]
  isolated: string[]
}

export function splitCoverageBatches(files: string[]): CoverageBatches {
  return {
    main: files.filter((file) => !ISOLATED_COVERAGE_FILES.has(file)),
    isolated: files.filter((file) => ISOLATED_COVERAGE_FILES.has(file)),
  }
}

async function collectTests(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(packageRoot, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) return collectTests(relative)
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [relative]
      return []
    }),
  )
  return nested.flat()
}

async function runBatch(files: string[], shard: number, env: Record<string, string | undefined>): Promise<number> {
  if (files.length === 0) return 0
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "30000",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${path.join("coverage", "shards", String(shard))}`,
      ...files,
    ],
    {
      cwd: packageRoot,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  return child.exited
}

export async function runBatches(
  files: string[],
  env: Record<string, string | undefined>,
  runBatch: (files: string[], shard: number, env: Record<string, string | undefined>) => Promise<number>,
): Promise<number> {
  const { main, isolated } = splitCoverageBatches(files)
  const failed: Array<{ shard: number; exitCode: number }> = []
  const mainExit = await runBatch(main, 0, env)
  if (mainExit !== 0) failed.push({ shard: 0, exitCode: mainExit })
  let shard = 1
  for (const file of isolated) {
    const exitCode = await runBatch([file], shard++, env)
    if (exitCode !== 0) failed.push({ shard: shard - 1, exitCode })
  }
  if (failed.length > 0) {
    console.error(
      `coverage batches failed: ${failed.map(({ shard, exitCode }) => `shard ${shard} (exit ${exitCode})`).join(", ")}`,
    )
    return 1
  }
  return 0
}

export async function main() {
  const shardRoot = path.join(packageRoot, "coverage", "shards")
  await rm(shardRoot, { recursive: true, force: true })
  await mkdir(shardRoot, { recursive: true })

  const files = (await collectTests("test")).toSorted()
  const isolatedEnv = await createIsolatedTestEnv()
  try {
    // process.exit would skip this finally and leak the isolated env, so the
    // failure signal is an exit code set after dispose() has run.
    process.exitCode = await runBatches(files, isolatedEnv.env, runBatch)
  } finally {
    await isolatedEnv.dispose()
  }
}

if (import.meta.main) await main()
