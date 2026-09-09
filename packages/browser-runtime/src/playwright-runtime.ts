import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { BrowserType } from "playwright-core"

interface PlaywrightModule {
  chromium: BrowserType
}

interface PlaywrightRegistry {
  resolveBrowsers(names: string[], options?: Record<string, never>): unknown[]
  installDeps(executables: unknown[], dryRun: boolean): Promise<void>
}

interface PlaywrightCoreBundle {
  registry: {
    registry: PlaywrightRegistry
  }
}

interface LoadOptions {
  executablePath?: string
  sourceRequire?: (specifier: string) => unknown
}

export namespace PlaywrightRuntime {
  export function load(options: LoadOptions = {}): PlaywrightModule {
    const packaged = packagedPath(options.executablePath, "index.js")
    if (existsSync(packaged)) return createRequire(packaged)(packaged) as PlaywrightModule
    const sourceRequire = options.sourceRequire ?? createRequire(import.meta.url)
    return sourceRequire("playwright-core") as PlaywrightModule
  }

  export function version(options: LoadOptions = {}): string {
    const packaged = packagedPath(options.executablePath, "package.json")
    const metadata = existsSync(packaged)
      ? (createRequire(packaged)(packaged) as { version?: unknown })
      : ((options.sourceRequire ?? createRequire(import.meta.url))("playwright-core/package.json") as {
          version?: unknown
        })
    if (typeof metadata.version !== "string") throw new Error("Playwright Core version metadata is invalid.")
    return metadata.version
  }

  export async function installChromiumDependencies(
    options: {
      coreBundle?: PlaywrightCoreBundle
      executablePath?: string
      sourceRequire?: (specifier: string) => unknown
    } = {},
  ): Promise<void> {
    const coreBundle = options.coreBundle ?? loadCoreBundle(options)
    const registry = coreBundle.registry.registry
    const executables = registry.resolveBrowsers(["chromium"], {})
    await registry.installDeps(executables, false)
  }
}

function loadCoreBundle(options: LoadOptions): PlaywrightCoreBundle {
  const packaged = packagedPath(options.executablePath, "lib", "coreBundle.js")
  if (existsSync(packaged)) return createRequire(packaged)(packaged) as PlaywrightCoreBundle
  const sourceRequire = options.sourceRequire ?? createRequire(import.meta.url)
  return sourceRequire("playwright-core/lib/coreBundle") as PlaywrightCoreBundle
}

function packagedPath(executablePath = process.execPath, ...parts: string[]): string {
  return path.resolve(path.dirname(executablePath), "..", "browser-runtime", "playwright-core", ...parts)
}
