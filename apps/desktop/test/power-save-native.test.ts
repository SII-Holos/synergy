import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { captureOutput } from "./fixture/process-output"

test.skipIf(process.env.SYNERGY_DESKTOP_RUNTIME_TEST !== "1" || process.platform !== "darwin")(
  "member activity shares a real macOS power assertion across window close and releases it on quit",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-member-power-"))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const build = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "fixture/power-save-native.ts")],
        outdir: directory,
        target: "node",
        external: ["electron"],
      })
      if (!build.success) throw new AggregateError(build.logs, "Power fixture build failed")
      const electron: unknown = process.env.SYNERGY_DESKTOP_ELECTRON_BIN ?? createRequire(import.meta.url)("electron")
      if (typeof electron !== "string") throw new Error("Electron executable path is unavailable")
      const launched = Bun.spawn(
        [electron, `--user-data-dir=${path.join(directory, "electron")}`, path.join(directory, "power-save-native.js")],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      child = launched
      const stdout = captureOutput(launched.stdout)
      const stderr = captureOutput(launched.stderr)
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        stdout.cancel()
        stderr.cancel()
        if (launched.exitCode === null) launched.kill("SIGKILL")
      }, 15_000)
      try {
        const code = await launched.exited
        await Promise.all([stdout.done, stderr.done])
        if (code || timedOut)
          throw new Error(`Power fixture failed (${code}, timeout=${timedOut}): ${stdout.text()}\n${stderr.text()}`)
        expect(stdout.text()).toContain("Native member power checks passed")
        const result = await promisify(execFile)("/usr/bin/pmset", ["-g", "assertions"])
        expect(result.stdout.split("\n").filter((line) => line.includes(`pid ${launched.pid}(`))).toEqual([])
      } finally {
        clearTimeout(timeout)
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)
