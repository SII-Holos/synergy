import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const runtimeTest = process.env.SYNERGY_DESKTOP_RUNTIME_TEST === "1" ? test : test.skip
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("Electron Browser Host broker contract", () => {
  for (const fixture of ["browser-native-page-pool", "browser-multi-page"])
    runtimeTest(
      `validates native browser contract: ${fixture}`,
      async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-native-smoke-"))
        temporaryDirectories.push(directory)
        const build = await Bun.build({
          entrypoints: [path.resolve(import.meta.dir, `fixture/${fixture}.ts`)],
          outdir: directory,
          target: "node",
          external: ["electron"],
        })
        const preloadBuild = await Bun.build({
          entrypoints: [path.resolve(import.meta.dir, "../src/browser-page-preload.ts")],
          outdir: directory,
          naming: "browser-page-preload.cjs",
          target: "node",
          format: "cjs",
          external: ["electron"],
        })
        if (!preloadBuild.success) throw new AggregateError(preloadBuild.logs, "Browser prompt preload did not build.")
        if (!build.success) throw new AggregateError(build.logs, "Native Browser smoke fixture did not build.")
        const electron =
          process.env.SYNERGY_DESKTOP_ELECTRON_BIN ??
          path.resolve(
            import.meta.dir,
            "../node_modules/electron/dist",
            (await Bun.file(path.resolve(import.meta.dir, "../node_modules/electron/path.txt")).text()).trim(),
          )
        const child = Bun.spawn(
          [
            electron,
            ...(process.platform === "linux" ? ["--no-sandbox"] : []),
            await isolatedElectronEntry(directory, path.join(directory, `${fixture}.js`)),
          ],
          { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
        )
        const stdout = new Response(child.stdout).text().catch(() => "")
        const stderr = new Response(child.stderr).text().catch(() => "")
        let exitCode: number
        try {
          exitCode = await withTimeout(child.exited, 30_000, "Native Browser page pool smoke")
        } catch (error) {
          child.kill("SIGTERM")
          await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
          if (child.exitCode === null) child.kill("SIGKILL")
          const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
          throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdoutText}\n${stderrText}`)
        }
        const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
        if (exitCode !== 0) {
          throw new Error(`Native Browser page pool exited with ${exitCode}.\n${stdoutText}\n${stderrText}`)
        }
      },
      45_000,
    )
})

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

async function isolatedElectronEntry(directory: string, entry: string): Promise<string> {
  const wrapper = path.join(directory, "isolated-electron.mjs")
  await fs.writeFile(
    wrapper,
    [
      'import { app } from "electron";',
      'import { pathToFileURL } from "node:url";',
      `app.setPath("userData", ${JSON.stringify(path.join(directory, "user-data"))});`,
      `await import(pathToFileURL(${JSON.stringify(entry)}).href);`,
    ].join("\n"),
  )
  return wrapper
}
