import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PlaywrightRuntime } from "../../src/browser/playwright-runtime"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("PlaywrightRuntime", () => {
  test("loads Playwright Core from the runtime beside a packaged executable", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-playwright-runtime-"))
    temporaryDirectories.push(runtime)
    const executable = path.join(runtime, "bin", "synergy")
    const playwright = path.join(runtime, "browser-runtime", "playwright-core")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.mkdir(playwright, { recursive: true })
    await fs.writeFile(
      path.join(playwright, "index.js"),
      "module.exports = { chromium: { name: 'packaged-chromium' } }\n",
    )

    const loaded = PlaywrightRuntime.load({
      executablePath: executable,
      sourceRequire() {
        throw new Error("source Playwright must not be used")
      },
    })

    expect((loaded.chromium as unknown as { name: string }).name).toBe("packaged-chromium")
  })

  test("installs the dependency groups for Chromium through Playwright Core", async () => {
    const resolved = [{ name: "chromium" }, { name: "ffmpeg" }]
    let installed: { executables: unknown[]; dryRun: boolean } | undefined

    await PlaywrightRuntime.installChromiumDependencies({
      coreBundle: {
        registry: {
          registry: {
            resolveBrowsers(names) {
              expect(names).toEqual(["chromium"])
              return resolved
            },
            async installDeps(executables, dryRun) {
              installed = { executables, dryRun }
            },
          },
        },
      },
    })

    expect(installed).toEqual({ executables: resolved, dryRun: false })
  })
})
