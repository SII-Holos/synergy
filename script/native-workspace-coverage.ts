import path from "node:path"
import fs from "node:fs/promises"
import { createIsolatedTestEnv } from "../packages/testing/src/env"

const directory = path.resolve(import.meta.dir, "../packages/local-runtime")
const windows = process.platform === "win32"
// Keep native reports separate from the numeric batches produced on Linux.
const output = path.join(directory, "coverage/shards", windows ? "1000001" : "1000000")
export function nativeWorkspaceBatches(windows: boolean) {
  const suites = windows
    ? [
        "test/process/owned-process-windows.test.ts",
        "test/workspace/windows-bash-footprint.test.ts",
        "test/workspace-file/long-path.test.ts",
        "test/workspace-file/mutation.test.ts",
        "test/workspace-file/snapshot-links.test.ts",
        "test/workspace-file/crash-publication.test.ts",
        "test/process-shutdown.test.ts",
        "test/session/shell.test.ts",
        "test/workspace/change-attribution.test.ts",
        "test/sandbox/async-execution.test.ts",
        "test/file/watcher-events.test.ts",
        "test/sandbox/phase3-windows-config.test.ts",
        "test/session/tool-resolver-bash-profile.test.ts",
      ]
    : [
        "test/process/owned-process.test.ts",
        "test/session/shell.test.ts",
        "test/workspace/change-attribution.test.ts",
        "test/sandbox/async-execution.test.ts",
        "test/process/native-pty.test.ts",
        "test/process/pty.test.ts",
        "test/workspace/coordinator.test.ts",
        "test/workspace/darwin-coalition.test.ts",
        "test/workspace/bash-footprint.test.ts",
        "test/sandbox/write-footprint.test.ts",
        "test/process-shutdown.test.ts",
        "test/session/tool-resolver-bash-profile.test.ts",
        "test/workspace-file",
        "test/file/watcher-events.test.ts",
      ]
  suites.push(
    "test/environment/executor.test.ts",
    "test/process/native-bindings.test.ts",
    "test/workspace/coordinator-environment.test.ts",
    "test/workspace/process.test.ts",
    "test/workspace/workspace-concurrency.test.ts",
    "../harness/test/session/snapshot-long-path.test.ts",
    "../formatter/test/format/formatter.test.ts",
    "../lsp/test/lsp/owner-runtime.test.ts",
    "../lsp/test/lsp/process.test.ts",
  )
  return windows
    ? [suites.filter((_, index) => index % 2 === 0), suites.filter((_, index) => index % 2 === 1)]
    : [suites]
}

if (import.meta.main) {
  await fs.rm(output, { recursive: true, force: true })
  const results = await Promise.allSettled(
    nativeWorkspaceBatches(windows).map(async (suites, index) => {
      const isolation = await createIsolatedTestEnv()
      const directoryOutput = path.join(output, String(index))
      try {
        await fs.mkdir(directoryOutput, { recursive: true })
        const child = Bun.spawn(
          [
            process.execPath,
            "test",
            "--timeout",
            "30000",
            "--coverage",
            "--reporter=junit",
            `--reporter-outfile=${path.join(directoryOutput, "junit.xml")}`,
            "--coverage-reporter=lcov",
            `--coverage-dir=${directoryOutput}`,
            ...suites,
          ],
          { cwd: directory, env: isolation.env, stdout: "inherit", stderr: "inherit" },
        )
        const code = await child.exited
        const report = Bun.file(path.join(directoryOutput, "lcov.info"))
        if (await report.exists()) {
          const source = await report.text()
          await Bun.write(
            report,
            source.replace(
              /^SF:([^\n]+)$/gm,
              (_line, file: string) =>
                `SF:${path
                  .relative(directory, path.resolve(directory, file.replace(/\r$/, "")))
                  .split(path.sep)
                  .join("/")}`,
            ),
          )
        }
        return code
      } finally {
        await isolation.dispose()
      }
    }),
  )
  const rejected = results.find((result) => result.status === "rejected")
  if (rejected?.status === "rejected") throw rejected.reason
  process.exitCode = results.some((result) => result.status === "fulfilled" && result.value !== 0) ? 1 : 0
}
