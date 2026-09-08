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

import { createIsolatedTestEnv } from "../src/env"
const repositoryRoot = path.resolve(import.meta.dir, "../../..")

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
  // Config projection registration is permanent for the process composition.
  "packages/harness/test/config/extensions-field.test.ts",
  // Mailbox owns the process-wide native provider resolver.
  "packages/connections/test/holos/mailbox.test.ts",
  // GitHub transport redirects global fetch to its loopback server and owns auth caches.
  "packages/connections/test/channel/provider/github/api-transport.test.ts",
  "packages/agent-integrations/test/mcp/owner-lifecycle.test.ts",
  "packages/connections/test/holos/legacy-data-migration.test.ts",
  // Integration fixtures own subprocess singletons; migration fixtures temporarily select their own home.
  "packages/agent-integrations/test/format/formatter.test.ts",
  "packages/agent-integrations/test/external-agent/openclaw.test.ts",
  "packages/agent-integrations/test/lsp/owner-runtime.test.ts",
  // Product data commands mock terminal prompts and mutate the isolated home override.
  // This fixture registers and rolls back a private migration domain and captures CLI output.
  // CLI diagnostics inspect a temporary cwd and capture the terminal output boundary.
  "packages/cli/test/cli/read-commands.test.ts",
  "packages/cli/test/cli/data-home-command.test.ts",
  "packages/cli/test/cli/transcript-commands.test.ts",
  "packages/cli/test/cli/migration-command.test.ts",
  "packages/plugin-host/test/plugin/tool-invocation.test.ts",
  "packages/product-runtime/test/cli/data.test.ts",
  "packages/product-runtime/test/cli/services.test.ts",
  "packages/connections/test/channel/clarus-invite-accept.test.ts",
  "packages/connections/test/channel/feishu-provider.test.ts",
  "packages/connections/test/channel/host.test.ts",
  "packages/connections/test/channel/managed-project-ownership.test.ts",
  "packages/connections/test/channel/svg-raster-standalone.test.ts",
  "packages/product-runtime/test/config/import.test.ts",
  "packages/connections/test/email/imap.test.ts",
  "packages/harness/test/global/test-home-guard.test.ts",
  "packages/harness/test/lifecycle/runtime.test.ts",
  "packages/runtime-local/test/sandbox/helper-source.test.ts",
  "packages/connections/test/holos/runtime.test.ts",
  "packages/library/test/database.test.ts",
  "packages/library/test/embedding.test.ts",
  "packages/library/test/embedding-local.test.ts",
  "packages/library/test/experience-recall.test.ts",
  "packages/library/test/experience-reencode.test.ts",
  "packages/product-runtime/test/plugin/mcp-declarative-oauth.test.ts",
  "packages/harness/test/provider/catalog-stability.test.ts",
  "packages/runtime-local/test/file/watcher.test.ts",
  "packages/runtime-local/test/provider/proxy.test.ts",
  "packages/product-runtime/test/server/nav-global-routes.test.ts",
  // Runtime startup must configure pools before any sibling suite has created them.
  "packages/product-runtime/test/server/resident-runtime.test.ts",
  "packages/product-runtime/test/server/runtime-handle.test.ts",
  // Global statistics scan all stored sessions, including sibling suites' intentionally partial fixtures.
  "packages/workbench/test/stats/engine.test.ts",
  "packages/product-runtime/test/server/plugin-official-install.test.ts",
  "packages/product-runtime/test/plugin/routes/plugin-registry-routes.test.ts",
  "packages/product-runtime/test/server/skill-route.test.ts",
  "packages/harness/test/session/retry.test.ts",
  "packages/connections/test/channel/clarus-assignment.test.ts",
  "packages/product-runtime/test/cli/daemon-entry.test.ts",
  // Daemon fixtures mutate the test home, platform identity and OS subprocess boundary.
  "packages/cli/test/daemon/lifecycle.test.ts",
  "packages/cli/test/daemon/platform-services.test.ts",
  "packages/cli/test/daemon/service.test.ts",
  "packages/cli/test/daemon/systemd.test.ts",
  "packages/cli/test/daemon/observe.test.ts",
  "packages/cli/test/daemon/spec.test.ts",
  "packages/harness/test/storage/storage-retry.test.ts",
  "packages/harness/test/storage/storage-silent-not-found.test.ts",
  "packages/product-runtime/test/tool/auto-expand.test.ts",
  "packages/media/test/tools/openai-image-gen.test.ts",
  "packages/runtime-local/test/tools/session-search.test.ts",
  "packages/library/test/vector/embedding-standalone.test.ts",
])

export interface CoverageBatches {
  main: string[]
  isolated: string[]
}

export function splitBatchFiles(files: string[], packageRoot = process.cwd()): CoverageBatches {
  const isIsolated = (file: string) => {
    const key = file.startsWith("packages/")
      ? file
      : path.relative(repositoryRoot, path.resolve(packageRoot, file)).split(path.sep).join("/")
    return ISOLATED_BATCH_FILES.has(key)
  }
  return { main: files.filter((file) => !isIsolated(file)), isolated: files.filter(isIsolated) }
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

export async function collectTests(directory: string, packageRoot = process.cwd()): Promise<string[]> {
  const entries = await readdir(path.join(packageRoot, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) return collectTests(relative, packageRoot)
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [relative]
      return []
    }),
  )
  return nested.flat()
}

export async function runBatch(
  files: string[],
  shard: number,
  env: Record<string, string | undefined>,
): Promise<number> {
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
      cwd: process.cwd(),
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
  const shardRoot = path.join(process.cwd(), "coverage", "shards")
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
