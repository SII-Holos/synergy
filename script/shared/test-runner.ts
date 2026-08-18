#!/usr/bin/env bun

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

export type TestRunnerOptions = {
  /** Package root; test files are collected under `<root>/test`. */
  root: string
  /** Per-test timeout for the main batch (ms). */
  timeoutMs: number
  /** Files that must run one at a time, serially, after the main batch. */
  isolated: string[]
  /** Per-test timeout for isolated batches (defaults to `timeoutMs`). */
  isolatedTimeoutMs?: number
  /** Files that need `--conditions=browser`; run as one serial batch. */
  browserOnly: string[]
  /** Per-test timeout for the browser batch (defaults to `timeoutMs`). */
  browserTimeoutMs?: number
  /** Extra files run one at a time, serially, after the browser batch. */
  extraSerial?: string[]
}

/**
 * Sharded test runner shared by packages/app and packages/ui.
 *
 * Collects `*.test.{ts,tsx}` files under `<root>/test`, runs the main batch in
 * one `bun test` process, then runs isolated files and the browser-only batch
 * serially so Playwright/Vite suites keep their Chromium processes alive.
 * In coverage mode each batch writes into `coverage/shards/<shard>` because
 * `bun test` overwrites `coverage/lcov.info` on every invocation.
 */
export async function runBatchedTests(options: TestRunnerOptions) {
  const { root, timeoutMs, isolated, browserOnly, extraSerial = [] } = options
  const isolatedTimeoutMs = options.isolatedTimeoutMs ?? timeoutMs
  const browserTimeoutMs = options.browserTimeoutMs ?? timeoutMs
  const failedBatches: Array<{ shard: number; exitCode: number }> = []

  async function collectTests(directory: string): Promise<string[]> {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const relative = path.posix.join(directory, entry.name)
        if (entry.isDirectory()) return collectTests(relative)
        if (/\.test\.(ts|tsx)$/.test(entry.name)) return [relative]
        return []
      }),
    )
    return nested.flat()
  }

  async function run(files: string[], shard: number, batch: { browser?: boolean; timeout?: number } = {}) {
    if (files.length === 0) return
    const coverage = process.argv.includes("--coverage")
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--timeout",
        String(batch.timeout ?? timeoutMs),
        // Bun overwrites coverage/lcov.info on every invocation, so coverage
        // mode writes each batch into its own shard directory; coverage:check
        // merges them. Without this, the final serial batch would erase all
        // coverage from the main batch.
        ...(coverage ? ["--coverage", "--coverage-reporter=lcov", "--coverage-dir", `coverage/shards/${shard}`] : []),
        ...(batch.browser ? ["--conditions=browser"] : []),
        ...files,
      ],
      {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    const exitCode = await child.exited
    if (exitCode !== 0) failedBatches.push({ shard, exitCode })
  }

  const coverage = process.argv.includes("--coverage")
  if (coverage) {
    await rm(path.join(root, "coverage", "shards"), { recursive: true, force: true })
    await mkdir(path.join(root, "coverage", "shards"), { recursive: true })
  }

  const isolatedSet = new Set(isolated)
  const browserSet = new Set(browserOnly)
  const extraSerialSet = new Set(extraSerial)
  const files = (await collectTests("test")).toSorted()
  await run(
    files.filter((file) => !isolatedSet.has(file) && !browserSet.has(file) && !extraSerialSet.has(file)),
    0,
  )
  let shard = 1
  for (const file of files.filter((file) => isolatedSet.has(file))) {
    await run([file], shard++, { timeout: isolatedTimeoutMs })
  }
  await run(
    files.filter((file) => browserSet.has(file)),
    shard++,
    { browser: true, timeout: browserTimeoutMs },
  )
  for (const file of extraSerial) await run([file], shard++)

  if (failedBatches.length > 0) {
    console.error(
      `test batches failed: ${failedBatches.map(({ shard, exitCode }) => `shard ${shard} (exit ${exitCode})`).join(", ")}`,
    )
    process.exit(1)
  }
}
