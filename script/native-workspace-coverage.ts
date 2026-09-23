import path from "node:path"
import fs from "node:fs/promises"
import { createIsolatedTestEnv } from "../packages/testing/src/env"

const directory = path.resolve(import.meta.dir, "../packages/runtime-local")
const windows = process.platform === "win32"
// Keep native reports separate from the numeric batches produced on Linux.
const output = path.join(directory, "coverage/shards", windows ? "1000001" : "1000000")
const suites = windows
  ? [
      "test/process/owned-process-windows.test.ts",
      "test/workspace/windows-bash-footprint.test.ts",
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
suites.push("../agent-integrations/test/format/formatter.test.ts")
const isolation = await createIsolatedTestEnv()
try {
  await fs.rm(output, { recursive: true, force: true })
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "30000",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${output}`,
      ...suites,
    ],
    { cwd: directory, env: isolation.env, stdout: "inherit", stderr: "inherit" },
  )
  process.exitCode = await child.exited
  const report = Bun.file(path.join(output, "lcov.info"))
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
} finally {
  await isolation.dispose()
}
