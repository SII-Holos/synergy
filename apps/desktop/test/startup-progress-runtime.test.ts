import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import { createRequire } from "node:module"
import path from "node:path"

test.skipIf(process.env.SYNERGY_DESKTOP_RUNTIME_TEST !== "1")(
  "renders live migration progress in Electron",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-startup-ui-"))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const build = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "fixture/startup-progress.ts")],
        outdir: directory,
        target: "node",
        external: ["electron"],
      })
      if (!build.success) throw new AggregateError(build.logs, "Startup fixture build failed")
      const electron: unknown = process.env.SYNERGY_DESKTOP_ELECTRON_BIN ?? createRequire(import.meta.url)("electron")
      if (typeof electron !== "string") throw new Error("Electron executable path is unavailable")
      const launched = Bun.spawn(
        [
          electron,
          `--user-data-dir=${path.join(directory, "electron")}`,
          ...(os.platform() === "linux" ? ["--no-sandbox"] : []),
          path.join(directory, "startup-progress.js"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      child = launched
      const stdout = new Response(launched.stdout).text()
      const stderr = new Response(launched.stderr).text()
      const timeout = setTimeout(() => launched.kill("SIGKILL"), 60_000)
      try {
        const code = await launched.exited
        expect({ code, stdout: code ? await stdout : "", stderr: code ? await stderr : "" }).toEqual({
          code: 0,
          stdout: "",
          stderr: "",
        })
        expect(await stdout).toContain("Startup progress DOM checks passed")
        await stderr
      } finally {
        clearTimeout(timeout)
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  75_000,
)
