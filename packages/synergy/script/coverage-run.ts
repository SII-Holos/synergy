#!/usr/bin/env bun

/**
 * Synergy batch planner. The main test batch is split into a few sequential
 * single-process shards by stable file-name hash (default 4,
 * SYNERGY_BATCH_SHARDS) so one file's leaked module state can never poison
 * the whole suite and editing the isolation list never reshuffles the
 * remaining files' shard assignments, while a small set of files that stay
 * flaky even in a small shard execute in their own isolated processes. Both
 * the coverage runner (this file) and script/test-ci.ts consume the same
 * split, and every batch writes lcov under coverage/shards/<n>/, which
 * script/coverage-check.ts merges with union semantics.
 */

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

import { createIsolatedTestEnv } from "./test-env"
const packageRoot = path.resolve(import.meta.dir, "..")

/**
 * Test files that fail even inside a small coverage shard. Each passes in
 * isolation; the failure modes are load- or state-sensitive:
 * - standalone Bun.build fixtures (embedding-standalone, svg-raster) hit
 *   "Unexpected reading file" on the transformers runtime under a full run;
 * - embedding and embedding-local drive the real transformers/ONNX runtime
 *   and exceed the run timeout under batch load (35s+), so they need their
 *   own process;
 * - nav-global-routes asserts home-scope completion counters that sibling
 *   files can mutate;
 * - openai-image-gen's global fetch mock races with sibling fetch mocks;
 * - auto-expand mocks 15 module functions and drives the real tool scheduler
 *   and session store, so a shared run with failing sibling fixtures (plugin
 *   registry, network) settles its parts as errors;
 * - host/managed-project-ownership/imap assert against global config and
 *   channel registries that a prior sibling's stale Config.current override
 *   or late rejection poisons (whole-file sub-millisecond failures on CI,
 *   2026-09-04), so they get their own process;
 * - experience-recall, experience-reencode, and database assert against the
 *   LibraryDB singleton that sibling library suites repopulate, clean, or
 *   leave stale handles across (intermittent zero-candidate, stale reopen
 *   returning an empty current job, and dimension-drift failures in shared
 *   batches);
 * - storage-retry spies global fs rename/unlink, storage-silent-not-found
 *   asserts metrics on a shared observability store, clarus-invite-accept
 *   reads shared channel/Clarus state, feishu-provider races SVG raster
 *   fallbacks, session-search scans live session stores under the shared
 *   home, and test-home-guard runs the subprocess contract around the
 *   real-home guard, so each also runs alone;
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
export const ISOLATED_BATCH_FILES: ReadonlySet<string> = new Set([
  "test/channel/clarus-invite-accept.test.ts",
  "test/channel/feishu-provider.test.ts",
  "test/channel/host.test.ts",
  "test/channel/managed-project-ownership.test.ts",
  "test/channel/svg-raster-standalone.test.ts",
  "test/config/import.test.ts",
  "test/email/imap.test.ts",
  "test/global/test-home-guard.test.ts",
  "test/holos/runtime.test.ts",
  "test/library/database.test.ts",
  "test/library/embedding.test.ts",
  "test/library/embedding-local.test.ts",
  "test/library/experience-recall.test.ts",
  "test/library/experience-reencode.test.ts",
  "test/plugin/mcp-declarative-oauth.test.ts",
  "test/provider/catalog-stability.test.ts",
  "test/provider/proxy.test.ts",
  "test/server/nav-global-routes.test.ts",
  "test/server/plugin-official-install.test.ts",
  "test/server/plugin-registry-routes.test.ts",
  "test/server/skill-route.test.ts",
  "test/session/retry.test.ts",
  "test/channel/clarus-assignment.test.ts",
  "test/cli/daemon-entry.test.ts",
  "test/daemon/observe.test.ts",
  "test/daemon/spec.test.ts",
  "test/storage/storage-retry.test.ts",
  "test/storage/storage-silent-not-found.test.ts",
  "test/tool/auto-expand.test.ts",
  "test/tool/openai-image-gen.test.ts",
  "test/tool/session-search.test.ts",
  "test/vector/embedding-standalone.test.ts",
])

export interface CoverageBatches {
  main: string[]
  isolated: string[]
}

export function splitBatchFiles(files: string[]): CoverageBatches {
  return {
    main: files.filter((file) => !ISOLATED_BATCH_FILES.has(file)),
    isolated: files.filter((file) => ISOLATED_BATCH_FILES.has(file)),
  }
}

export function batchShardCount(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env["SYNERGY_BATCH_SHARDS"] ?? "", 10)
  if (!Number.isInteger(parsed) || parsed < 1) return 4
  return parsed
}

export function shardMainFiles(files: string[], shardCount: number): string[][] {
  const shards: string[][] = Array.from({ length: shardCount }, () => [])
  for (const file of files) shards[shardIndexOf(file, shardCount)]!.push(file)
  return shards
}

/**
 * FNV-1a over the file path. A file's shard depends only on its own name, so
 * editing the isolation list or adding suites never reshuffles the shard
 * assignments of the files that remain — position-based dealing turned every
 * list edit into a full recombination that kept exposing new order-dependent
 * victims (boss-workflow, 2026-09-05).
 */
function shardIndexOf(file: string, shardCount: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < file.length; index++) {
    hash ^= file.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shardCount
}

export async function collectTests(directory: string): Promise<string[]> {
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
  const { main, isolated } = splitBatchFiles(files)
  const failed: Array<{ shard: number; exitCode: number }> = []
  let shard = 0
  for (const shardFiles of shardMainFiles(main, batchShardCount(env))) {
    if (shardFiles.length === 0) continue
    const exitCode = await runBatch(shardFiles, shard, env)
    if (exitCode !== 0) failed.push({ shard, exitCode })
    shard++
  }
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
