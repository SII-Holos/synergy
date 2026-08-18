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
 */
export const ISOLATED_COVERAGE_FILES: ReadonlySet<string> = new Set([
  "test/vector/embedding-standalone.test.ts",
  "test/channel/svg-raster-standalone.test.ts",
  "test/server/nav-global-routes.test.ts",
  "test/tool/openai-image-gen.test.ts",
  "test/tool/auto-expand.test.ts",
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
      if (/\.test\.tsx?$/.test(entry.name)) return [relative]
      return []
    }),
  )
  return nested.flat()
}

async function runBatch(files: string[], shard: number): Promise<number> {
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
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  return child.exited
}

async function main() {
  const shardRoot = path.join(packageRoot, "coverage", "shards")
  await rm(shardRoot, { recursive: true, force: true })
  await mkdir(shardRoot, { recursive: true })

  const files = (await collectTests("test")).toSorted()
  const { main, isolated } = splitCoverageBatches(files)

  const failed: Array<{ shard: number; exitCode: number }> = []
  const mainExit = await runBatch(main, 0)
  if (mainExit !== 0) failed.push({ shard: 0, exitCode: mainExit })
  let shard = 1
  for (const file of isolated) {
    const exitCode = await runBatch([file], shard++)
    if (exitCode !== 0) failed.push({ shard: shard - 1, exitCode })
  }
  if (failed.length > 0) {
    console.error(
      `coverage batches failed: ${failed.map(({ shard, exitCode }) => `shard ${shard} (exit ${exitCode})`).join(", ")}`,
    )
    process.exit(1)
  }
}

if (import.meta.main) await main()
