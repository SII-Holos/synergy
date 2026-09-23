import path from "node:path"
import fs from "node:fs/promises"
import { createIsolatedTestEnv } from "../packages/testing/src/env"

const directory = path.resolve(import.meta.dir, "../packages/runtime-local")
// Keep the native report separate from the numeric batches produced on Linux.
const output = path.join(directory, "coverage/shards/1000000")
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
      "test/process/owned-process.test.ts",
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
    ],
    { cwd: directory, env: isolation.env, stdout: "inherit", stderr: "inherit" },
  )
  process.exitCode = await child.exited
} finally {
  await isolation.dispose()
}
