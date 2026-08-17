#!/usr/bin/env bun

import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const failedBatches: Array<{ shard: number; exitCode: number }> = []
const isolated = "test/app-build-css-contract.test.ts"
const browserOnly = [
  "test/components/note/document-editor-core.test.ts",
  "test/components/terminal/dispose-reentrancy.test.ts",
  "test/context/font-preference-provider.test.ts",
  "test/pages/fatal-error.test.tsx",
  "test/plugin/builtin-navigation.test.ts",
  "test/plugin/registries/tool-renderer-registry.test.ts",
]
// Playwright suites launch Chromium. bun test runs files in parallel worker
// processes and reaps dangling children when a worker exits, which can kill a
// sibling suite's freshly launched browser. Run every Chromium suite serially
// after the main batch to keep their processes alive.
const playwrightIsolated = [
  "test/components/app-shell/mobile-drawer-root.test.tsx",
  "test/components/dialog/model-selector-layout.test.ts",
  "test/components/file-workbench/selection.test.ts",
  "test/components/library/filter-menu-surface.test.ts",
  "test/components/menu-field/menu-field.test.ts",
  "test/components/settings/components/ThemePicker.behavior.test.tsx",
  "test/components/settings/settings-dialog-dismiss.test.tsx",
  "test/components/settings/settings-mobile-layout.test.ts",
  "test/components/settings/panels/BossModePanel.test.ts",
  "test/components/session/question-prompt-style.test.ts",
  "test/components/session/raw-messages-layout.test.ts",
  "test/components/session/session-progress-island-motion.test.ts",
  "test/components/session/session-progress-todo-layout.test.ts",
  "test/components/session/conversation-row-retention.test.ts",
  "test/components/sidebar/channel-sidebar-layout.test.ts",
]

async function collectTests(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true })
  const tests: string[] = []
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory()) tests.push(...(await collectTests(relative)))
    if (entry.isFile() && /\.test\.(ts|tsx)$/.test(entry.name)) tests.push(relative)
  }
  return tests
}

async function run(tests: string[], options: { browser?: boolean; timeoutMs?: number } = {}, shard = 0) {
  // Playwright/Vite suites cold-start Chromium and Vite beyond the default
  // 5s hook timeout, so raise the per-test timeout (same as packages/ui).
  const timeout = options.timeoutMs ?? 30000
  const coverage = process.argv.includes("--coverage")
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      String(timeout),
      // Bun overwrites coverage/lcov.info on every invocation, so coverage
      // mode writes each batch into its own shard directory; coverage:check
      // merges them. Without this, the final serial batch would erase all
      // coverage from the main batch.
      ...(coverage ? ["--coverage", "--coverage-reporter=lcov", "--coverage-dir", `coverage/shards/${shard}`] : []),
      ...(options.browser ? ["--conditions=browser"] : []),
      ...tests,
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

const tests = (await collectTests("test")).toSorted()
await run(
  tests.filter((test) => test !== isolated && !browserOnly.includes(test) && !playwrightIsolated.includes(test)),
  {},
  0,
)
let shard = 1
for (const file of playwrightIsolated) await run([file], { timeoutMs: 120000 }, shard++)
await run(browserOnly, { browser: true }, shard++)
await run([isolated], {}, shard++)
if (failedBatches.length > 0) {
  console.error(
    `test batches failed: ${failedBatches.map(({ shard, exitCode }) => `shard ${shard} (exit ${exitCode})`).join(", ")}`,
  )
  process.exit(1)
}
