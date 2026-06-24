import path from "path"
import os from "os"
import fs from "fs/promises"
import { Global } from "../global/index.js"

async function fileExists(filepath: string): Promise<boolean> {
  try {
    return await Bun.file(filepath).exists()
  } catch {
    return false
  }
}

async function findChromiumInDir(dir: string): Promise<string | null> {
  const names = ["chrome", "chromium", "Chrome", "Chromium", "Google Chrome"]

  for (const name of names) {
    const candidate = path.join(dir, name)
    if (await fileExists(candidate)) return candidate
  }

  try {
    const subdirs = await fs.readdir(dir, { withFileTypes: true })
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue
      const subpath = path.join(dir, subdir.name)
      for (const name of names) {
        const candidate = path.join(subpath, name)
        if (await fileExists(candidate)) return candidate
      }
    }
  } catch {
    // dir doesn't exist or can't be read
  }

  return null
}

async function findPlaywrightChromium(cacheDir: string, platform: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue

      if (platform === "darwin") {
        const candidate = path.join(cacheDir, entry.name, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
        if (await fileExists(candidate)) return candidate
      } else {
        const candidate = path.join(cacheDir, entry.name, "chrome-linux", "chrome")
        if (await fileExists(candidate)) return candidate
      }
    }
  } catch {
    // cache dir doesn't exist or can't be read
  }

  return null
}

export namespace BrowserInstall {
  export interface Health {
    running: boolean
    chromiumPath: string | null
    installed: boolean
    version: string | null
  }

  export function chromiumDir(): string {
    return path.join(Global.Path.data, "browser", "chromium")
  }

  /** Discover Chromium in priority order. Returns null if not found. */
  export async function discoverChromium(): Promise<string | null> {
    const platform = os.platform()
    const home = os.homedir()

    // 1. $CHROMIUM_PATH env
    if (Bun.env.CHROMIUM_PATH) {
      if (await fileExists(Bun.env.CHROMIUM_PATH)) {
        return Bun.env.CHROMIUM_PATH
      }
    }

    // 2. Synergy-managed chromium directory
    const synergyResult = await findChromiumInDir(chromiumDir())
    if (synergyResult) return synergyResult

    // 3. Playwright caches
    const playwrightDir =
      platform === "darwin"
        ? path.join(home, "Library", "Caches", "ms-playwright")
        : path.join(home, ".cache", "ms-playwright")

    const playwrightResult = await findPlaywrightChromium(playwrightDir, platform)
    if (playwrightResult) return playwrightResult

    try {
      const { chromium } = await import("playwright-core")
      const execPath = chromium.executablePath()
      if (await fileExists(execPath)) return execPath
    } catch {
      // playwright-core not available
    }

    // 4. System paths
    const systemPaths =
      platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
    for (const sysPath of systemPaths) {
      if (await fileExists(sysPath)) return sysPath
    }

    // 5. Not found
    return null
  }

  /** Install/find Chromium. Uses discovery first, then playwright-core as fallback. Returns path to executable. */
  export async function installChromium(): Promise<string> {
    const discovered = await discoverChromium()
    if (discovered) return discovered

    try {
      const { chromium } = await import("playwright-core")
      const execPath = chromium.executablePath()
      if (await fileExists(execPath)) return execPath
    } catch {
      // playwright-core not available
    }

    throw new Error("Chromium not found. Install it via playwright-core or set CHROMIUM_PATH.")
  }

  /** Check if a Chromium binary is healthy. Just verify it exists + can run --version. */
  export async function healthCheck(chromiumPath: string): Promise<Health> {
    const exists = await fileExists(chromiumPath)
    if (!exists) {
      return {
        running: false,
        chromiumPath,
        installed: false,
        version: null,
      }
    }

    try {
      const proc = Bun.spawn([chromiumPath, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(proc.stdout).text()
      await proc.exited

      const installed = proc.exitCode === 0
      return {
        running: false,
        chromiumPath,
        installed,
        version: installed ? output.trim() || null : null,
      }
    } catch {
      return {
        running: false,
        chromiumPath,
        installed: false,
        version: null,
      }
    }
  }
}
