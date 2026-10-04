#!/usr/bin/env bun

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "../../packages/testing/src/env"

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

export function frontendBatches(files: string[], options: Omit<TestRunnerOptions, "root">) {
  const { timeoutMs, isolated, browserOnly, extraSerial = [] } = options
  const isolatedSet = new Set(isolated)
  const browserSet = new Set(browserOnly)
  const extraSerialSet = new Set(extraSerial)
  const batches = [
    {
      files: files.filter((file) => !isolatedSet.has(file) && !browserSet.has(file) && !extraSerialSet.has(file)),
      timeout: timeoutMs,
      browser: false,
    },
    ...files
      .filter((file) => isolatedSet.has(file))
      .map((file) => ({
        files: [file],
        timeout: options.isolatedTimeoutMs ?? timeoutMs,
        browser: browserSet.has(file),
      })),
    {
      files: files.filter((file) => browserSet.has(file) && !isolatedSet.has(file)),
      timeout: options.browserTimeoutMs ?? timeoutMs,
      browser: true,
    },
    ...extraSerial
      .filter((file) => files.includes(file))
      .map((file) => ({ files: [file], timeout: timeoutMs, browser: false })),
  ]
  return batches.map((batch, id) => ({ ...batch, id })).filter((batch) => batch.files.length)
}

/**
 * Sharded test runner shared by apps/web and packages/ui.
 *
 * Collects `*.test.{ts,tsx}` files under `<root>/test`, runs the main batch in
 * one `bun test` process, then runs isolated files and the browser-only batch
 * serially so Playwright/Vite suites keep their Chromium processes alive.
 * In coverage mode each batch writes into `coverage/shards/<shard>` because
 * `bun test` overwrites `coverage/lcov.info` on every invocation.
 */
export async function runBatchedTests(options: TestRunnerOptions) {
  const { root, timeoutMs } = options
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
    const reportRoot = path.join(root, "coverage/shards", String(shard))
    await mkdir(reportRoot, { recursive: true })
    const isolatedEnv = await createIsolatedTestEnv()
    const started = Date.now()
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout",
          String(batch.timeout ?? timeoutMs),
          "--reporter=junit",
          `--reporter-outfile=${path.join(reportRoot, "junit.xml")}`,
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
          env: isolatedEnv.env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      )
      const exitCode = await child.exited
      await Bun.write(
        path.join(reportRoot, "timing.json"),
        JSON.stringify({ files, started, completed: Date.now(), seconds: (Date.now() - started) / 1000, exitCode }),
      )
      if (exitCode !== 0) failedBatches.push({ shard, exitCode })
    } finally {
      await isolatedEnv.dispose()
    }
  }

  const coverage = process.argv.includes("--coverage")
  if (coverage) {
    await rm(path.join(root, "coverage", "shards"), { recursive: true, force: true })
    await mkdir(path.join(root, "coverage", "shards"), { recursive: true })
  }

  const inventory = (await collectTests("test")).toSorted()
  const files: string[] = process.env.SYNERGY_TEST_FILES ? JSON.parse(process.env.SYNERGY_TEST_FILES) : inventory
  if (!files.length || files.some((file) => !inventory.includes(file)))
    throw new Error("Unknown or empty test selection")
  for (const batch of frontendBatches(files, options)) await run(batch.files, batch.id, batch)

  if (failedBatches.length > 0) {
    console.error(
      `test batches failed: ${failedBatches.map(({ shard, exitCode }) => `shard ${shard} (exit ${exitCode})`).join(", ")}`,
    )
    process.exit(1)
  }
}
