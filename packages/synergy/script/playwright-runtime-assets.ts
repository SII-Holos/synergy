import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

export const PLAYWRIGHT_CORE_RUNTIME_PATH = "browser-runtime/playwright-core"
export const PLAYWRIGHT_CORE_REQUIRED_PATHS = [
  `${PLAYWRIGHT_CORE_RUNTIME_PATH}/package.json`,
  `${PLAYWRIGHT_CORE_RUNTIME_PATH}/index.js`,
  `${PLAYWRIGHT_CORE_RUNTIME_PATH}/lib/coreBundle.js`,
] as const

export async function stagePlaywrightCoreRuntime(options: {
  runtimeDir: string
  playwrightCoreDir?: string
}): Promise<void> {
  const source = options.playwrightCoreDir ?? defaultPlaywrightCoreDir()
  for (const relative of ["package.json", "index.js", "lib/coreBundle.js"]) {
    if (!(await Bun.file(path.join(source, relative)).exists())) {
      throw new Error(`Playwright Core runtime is incomplete; missing ${relative}: ${source}`)
    }
  }

  const destination = path.join(options.runtimeDir, PLAYWRIGHT_CORE_RUNTIME_PATH)
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, { recursive: true, dereference: true })
}

function defaultPlaywrightCoreDir(): string {
  const require = createRequire(import.meta.url)
  return path.dirname(require.resolve("playwright-core/package.json"))
}
