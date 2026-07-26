import path from "path"
import os from "os"
import fs from "fs/promises"
import { createHash } from "node:crypto"
import z from "zod"
import unzipper from "unzipper"
import { Global } from "../global/index.js"
import { Installation } from "../global/installation.js"
import {
  BROWSER_PROTOCOL_VERSION,
  ChromiumManifestSchema,
  chromiumManifestName,
  chromiumReleaseTarget,
  type ChromiumReleaseArch,
  type ChromiumReleasePlatform,
} from "@ericsanchezok/synergy-browser"
import { isPathContained } from "../util/path-contain.js"

declare global {
  const SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY: string
  const SYNERGY_LIBC: string | undefined
}

const HostManifest = z
  .object({
    version: z.string().min(1).max(200),
    protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION),
    platform: z.enum(["darwin", "win32", "linux"]),
    arch: z.enum(["x64", "arm64"]),
    name: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024),
    url: z
      .string()
      .url()
      .max(20_000)
      .refine((value) => new URL(value).protocol === "https:", "Browser Host artifact URL must use HTTPS."),
    executable: z.string().min(1).max(20_000),
  })
  .strict()

export type BrowserHostManifest = z.infer<typeof HostManifest>
const hostInstalls = new Map<string, Promise<string>>()
const chromiumInstalls = new Map<string, Promise<ChromiumInstallReport>>()
const MANIFEST_DOWNLOAD_TIMEOUT_MS = 30_000
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export type ChromiumDiscoverySource = "env" | "managed" | "playwright" | "playwright-core" | "system"

export interface ChromiumReadinessCheck {
  id: string
  label: string
  status: "pass" | "warn" | "fail"
  detail: string
  recovery?: { command: string }
}

export interface ChromiumDiagnosis {
  ready: boolean
  chromiumPath: string | null
  discoverySource: ChromiumDiscoverySource | "not-found"
  browserVersion?: string
  checks: ChromiumReadinessCheck[]
}

export interface ChromiumInstallReport {
  action: "installed" | "reinstalled" | "up-to-date"
  executablePath: string
  browserVersion: string
  revision: string
  downloadBytes: number
}

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

async function findPlaywrightChromium(
  cacheDir: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<string | null> {
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue

      const candidates =
        platform === "darwin"
          ? [
              path.join(
                cacheDir,
                entry.name,
                arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
              ),
              path.join(cacheDir, entry.name, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
            ]
          : platform === "win32"
            ? [
                path.join(cacheDir, entry.name, "chrome-win64", "chrome.exe"),
                path.join(cacheDir, entry.name, "chrome-win", "chrome.exe"),
              ]
            : [
                path.join(cacheDir, entry.name, arch === "arm64" ? "chrome-linux" : "chrome-linux64", "chrome"),
                path.join(cacheDir, entry.name, "chrome-linux", "chrome"),
              ]
      for (const candidate of candidates) {
        if (await fileExists(candidate)) return candidate
      }
    }
  } catch {
    // cache dir doesn't exist or can't be read
  }

  return null
}

export namespace BrowserInstall {
  export function chromiumDir(): string {
    return path.join(Global.Path.data, "browser", "chromium")
  }

  export function chromiumLaunchArgs(): string[] {
    return [
      "--headless=new",
      "--disable-gpu",
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-breakpad",
    ]
  }

  export async function installChromium(
    options: {
      fetch?: typeof fetch
      publicKey?: string
      manifestBaseUrl?: string
      version?: string
      platform?: ChromiumReleasePlatform
      arch?: ChromiumReleaseArch
      libc?: "glibc" | "musl"
      destination?: string
      force?: boolean
    } = {},
  ): Promise<ChromiumInstallReport> {
    const destination = options.destination ?? chromiumDir()
    const active = chromiumInstalls.get(destination)
    if (active) return active
    const install = installChromiumOnce({ ...options, destination }).finally(() => chromiumInstalls.delete(destination))
    chromiumInstalls.set(destination, install)
    return install
  }

  export async function diagnoseChromium(
    options: {
      platform?: NodeJS.Platform
      discover?: () => Promise<{ path: string; source: ChromiumDiscoverySource } | null>
      launch?: (executablePath: string) => Promise<void>
      version?: (executablePath: string) => Promise<string>
      ldd?: (executablePath: string) => Promise<string>
    } = {},
  ): Promise<ChromiumDiagnosis> {
    const platform = options.platform ?? process.platform
    const discovered = await (options.discover ?? discoverChromiumWithSource)()
    if (!discovered) {
      return {
        ready: false,
        chromiumPath: null,
        discoverySource: "not-found",
        checks: [
          {
            id: "discovery",
            label: "Chromium discovery",
            status: "fail",
            detail: "No usable Chromium executable was found.",
            recovery: { command: "synergy browser install" },
          },
        ],
      }
    }

    const checks: ChromiumReadinessCheck[] = [
      {
        id: "discovery",
        label: "Chromium discovery",
        status: "pass",
        detail: `Found ${discovered.path} via ${discovered.source}.`,
      },
    ]
    let browserVersion: string | undefined
    try {
      const output = await (options.version ?? chromiumVersion)(discovered.path)
      browserVersion = output.match(/\d+(?:\.\d+){2,3}/)?.[0]
      checks.push({
        id: "version",
        label: "Chromium version",
        status: browserVersion ? "pass" : "warn",
        detail: browserVersion
          ? `Chromium ${browserVersion}.`
          : `Could not parse Chromium version from: ${output.trim()}`,
      })
    } catch (error) {
      checks.push({
        id: "version",
        label: "Chromium version",
        status: "warn",
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    if (platform === "linux") {
      try {
        const output = await (options.ldd ?? chromiumLdd)(discovered.path)
        const missing = output
          .split(/\r?\n/)
          .filter((line) => line.includes("not found"))
          .map((line) => line.trim().split(/\s+/)[0])
          .filter(Boolean)
        checks.push({
          id: "shared_libraries",
          label: "Linux shared libraries",
          status: missing.length ? "fail" : "pass",
          detail: missing.length ? `Missing: ${missing.join(", ")}.` : "Chromium shared libraries are available.",
        })
      } catch (error) {
        checks.push({
          id: "shared_libraries",
          label: "Linux shared libraries",
          status: "warn",
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      await (options.launch ?? launchChromiumProbe)(discovered.path)
      checks.push({ id: "launch", label: "Headless launch", status: "pass", detail: "Chromium launched successfully." })
    } catch (error) {
      checks.push({
        id: "launch",
        label: "Headless launch",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    return {
      ready: checks.every((check) => check.status !== "fail"),
      chromiumPath: discovered.path,
      discoverySource: discovered.source,
      browserVersion,
      checks,
    }
  }

  export function hostDir(version = Installation.VERSION): string {
    return path.join(Global.Path.data, "browser", "host", version, process.platform, process.arch)
  }

  export async function ensureHost(
    options: {
      fetch?: typeof fetch
      publicKey?: string
      manifestBaseUrl?: string
    } = {},
  ): Promise<string> {
    const existing = path.join(hostDir(), "executable")
    try {
      const marker = await fs.lstat(existing)
      if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Browser Host marker is unsafe.")
      const target = (await fs.readFile(existing, "utf8")).trim()
      const real = await fs.realpath(target)
      const executable = await fs.lstat(real)
      if (isPathContained(hostDir(), real) && executable.isFile() && !executable.isSymbolicLink()) return real
    } catch {}
    const key = hostDir()
    const active = hostInstalls.get(key)
    if (active) return active
    const install = installHost(options).finally(() => hostInstalls.delete(key))
    hostInstalls.set(key, install)
    return install
  }

  export async function installHost(
    options: {
      fetch?: typeof fetch
      publicKey?: string
      manifestBaseUrl?: string
      version?: string
      platform?: "darwin" | "win32" | "linux"
      arch?: "x64" | "arm64"
      destination?: string
    } = {},
  ): Promise<string> {
    const version = options.version ?? Installation.VERSION
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    if (version === "local") throw new Error("Signed Browser Host artifacts are unavailable for local source versions.")
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      throw new Error(`Browser Host is unavailable on ${platform}.`)
    }
    if (arch !== "x64" && arch !== "arm64") throw new Error(`Browser Host is unavailable on ${arch}.`)
    const request = options.fetch ?? fetch
    const name = `synergy-browser-host-${platform}-${arch}-${version}.manifest.json`
    const base = options.manifestBaseUrl ?? `https://github.com/SII-Holos/synergy/releases/download/v${version}`
    const [manifestResponse, signatureResponse] = await Promise.all([
      request(`${base}/${name}`, { signal: AbortSignal.timeout(MANIFEST_DOWNLOAD_TIMEOUT_MS) }),
      request(`${base}/${name}.sig`, { signal: AbortSignal.timeout(MANIFEST_DOWNLOAD_TIMEOUT_MS) }),
    ])
    if (!manifestResponse.ok || !signatureResponse.ok)
      throw new Error("Browser Host manifest is unavailable for this Synergy release.")
    const manifestText = await boundedText(manifestResponse, 128 * 1024)
    const signature = (await boundedText(signatureResponse, 16 * 1024)).trim()
    const publicKey =
      options.publicKey ??
      (typeof SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY === "string" ? SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY : "")
    if (!publicKey) throw new Error("Browser Host manifest verification key is not embedded in this Synergy build.")
    if (!(await verifyManifest(manifestText, signature, publicKey)))
      throw new Error("Browser Host manifest signature is invalid.")
    const manifest = HostManifest.parse(JSON.parse(manifestText))
    if (
      manifest.version !== version ||
      manifest.platform !== platform ||
      manifest.arch !== arch ||
      manifest.protocolVersion !== BROWSER_PROTOCOL_VERSION
    ) {
      throw new Error(
        "Browser Host manifest does not exactly match this Synergy version, platform, architecture, and protocol.",
      )
    }
    const expectedArtifactName = `synergy-browser-host-${platform}-${arch}-${version}.zip`
    if (
      manifest.name !== expectedArtifactName ||
      path.basename(new URL(manifest.url).pathname) !== expectedArtifactName
    ) {
      throw new Error("Browser Host manifest artifact name does not match the requested release.")
    }
    const artifactResponse = await request(manifest.url, {
      signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
    })
    if (!artifactResponse.ok) throw new Error(`Browser Host artifact download failed: HTTP ${artifactResponse.status}`)
    const artifact = await boundedBytes(artifactResponse, manifest.size)
    if (artifact.byteLength !== manifest.size)
      throw new Error("Browser Host artifact size does not match its signed manifest.")
    if (createHash("sha256").update(artifact).digest("hex") !== manifest.sha256)
      throw new Error("Browser Host artifact digest is invalid.")

    const destination = options.destination ?? hostDir(version)
    const parent = path.dirname(destination)
    const temp = path.join(parent, `.install-${crypto.randomUUID()}`)
    const archive = path.join(temp, "host.zip")
    const extracted = path.join(temp, "extracted")
    const backup = path.join(parent, `.previous-${crypto.randomUUID()}`)
    await fs.mkdir(extracted, { recursive: true })
    try {
      await Bun.write(archive, artifact)
      await extractSafeZip(archive, extracted)
      const executable = path.resolve(extracted, manifest.executable)
      if (!isPathContained(extracted, executable))
        throw new Error("Browser Host executable escapes the extracted artifact.")
      const stat = await fs.lstat(executable)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Browser Host executable is not a regular file.")
      if (platform !== "win32") await fs.chmod(executable, 0o755)
      await fs.mkdir(parent, { recursive: true })
      let movedPrevious = false
      try {
        await fs.rename(destination, backup)
        movedPrevious = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      try {
        await fs.rename(extracted, destination)
        const installedExecutable = path.join(destination, manifest.executable)
        await fs.writeFile(path.join(destination, "executable"), `${installedExecutable}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        if (movedPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
        return installedExecutable
      } catch (error) {
        await fs.rm(destination, { recursive: true, force: true })
        if (movedPrevious) await fs.rename(backup, destination)
        throw error
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true })
    }
  }

  export async function discoverChromium(
    options: {
      platform?: NodeJS.Platform
      arch?: string
      home?: string
      env?: Record<string, string | undefined>
      managedDir?: string
      playwrightCoreExecutable?: () => Promise<string | null>
    } = {},
  ): Promise<string | null> {
    return (await discoverChromiumWithSource(options))?.path ?? null
  }
}

async function installChromiumOnce(options: {
  fetch?: typeof fetch
  publicKey?: string
  manifestBaseUrl?: string
  version?: string
  platform?: ChromiumReleasePlatform
  arch?: ChromiumReleaseArch
  libc?: "glibc" | "musl"
  destination: string
  force?: boolean
}): Promise<ChromiumInstallReport> {
  const version = options.version ?? Installation.VERSION
  const platform = options.platform ?? (process.platform as ChromiumReleasePlatform)
  const arch = options.arch ?? (process.arch as ChromiumReleaseArch)
  const libc =
    options.libc ?? (process.platform === "linux" && typeof SYNERGY_LIBC === "string" ? SYNERGY_LIBC : "glibc")
  if (version === "local") throw new Error("Signed Chromium manifests are unavailable for local source versions.")
  if (platform === "linux" && libc === "musl") throw unsupportedChromium(platform, arch, "musl")
  if (!chromiumReleaseTarget(platform, arch, "version", "revision")) throw unsupportedChromium(platform, arch, libc)

  const hadExistingInstall = await fileExists(options.destination)
  const current = await installedChromium(options.destination, { version, platform, arch })
  if (current && !options.force) return { action: "up-to-date", ...current, downloadBytes: 0 }

  const request = options.fetch ?? fetch
  const manifestFilename = chromiumManifestName(version, platform, arch)
  const base = options.manifestBaseUrl ?? `https://github.com/SII-Holos/synergy/releases/download/v${version}`
  const [manifestResponse, signatureResponse] = await Promise.all([
    request(`${base}/${manifestFilename}`, { signal: AbortSignal.timeout(MANIFEST_DOWNLOAD_TIMEOUT_MS) }),
    request(`${base}/${manifestFilename}.sig`, { signal: AbortSignal.timeout(MANIFEST_DOWNLOAD_TIMEOUT_MS) }),
  ])
  if (!manifestResponse.ok || !signatureResponse.ok) {
    throw new Error("Signed Chromium manifest is unavailable for this Synergy release.")
  }
  const manifestText = await boundedText(manifestResponse, 128 * 1024)
  const signature = (await boundedText(signatureResponse, 16 * 1024)).trim()
  const publicKey =
    options.publicKey ??
    (typeof SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY === "string" ? SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY : "")
  if (!publicKey) throw new Error("Chromium manifest verification key is not embedded in this Synergy build.")
  if (!(await verifyManifest(manifestText, signature, publicKey)))
    throw new Error("Chromium manifest signature is invalid.")
  const manifest = ChromiumManifestSchema.parse(JSON.parse(manifestText))
  if (manifest.version !== version || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error("Chromium manifest does not exactly match this Synergy version, platform, and architecture.")
  }
  const target = chromiumReleaseTarget(platform, arch, manifest.browserVersion, manifest.revision)
  if (
    !target ||
    manifest.name !== target.name ||
    manifest.executable !== target.executable ||
    !target.urls.includes(manifest.url)
  ) {
    throw new Error("Chromium manifest artifact URL and layout do not match the requested Playwright release.")
  }

  const artifactResponse = await request(manifest.url, {
    signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
  })
  if (!artifactResponse.ok) throw new Error(`Chromium artifact download failed: HTTP ${artifactResponse.status}`)
  const artifact = await boundedBytes(artifactResponse, manifest.size)
  if (artifact.byteLength !== manifest.size)
    throw new Error("Chromium artifact size does not match its signed manifest.")
  if (createHash("sha256").update(artifact).digest("hex") !== manifest.sha256) {
    throw new Error("Chromium artifact digest is invalid.")
  }

  const parent = path.dirname(options.destination)
  const temp = path.join(parent, `.chromium-install-${crypto.randomUUID()}`)
  const archive = path.join(temp, "chromium.zip")
  const extracted = path.join(temp, "extracted")
  const backup = path.join(parent, `.chromium-previous-${crypto.randomUUID()}`)
  await fs.mkdir(extracted, { recursive: true })
  try {
    await Bun.write(archive, artifact)
    await extractSafeZip(archive, extracted)
    const executable = path.resolve(extracted, manifest.executable)
    if (!isPathContained(extracted, executable)) throw new Error("Chromium executable escapes the extracted artifact.")
    const stat = await fs.lstat(executable)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Chromium executable is not a regular file.")
    if (platform !== "win32") await fs.chmod(executable, 0o755)
    await fs.mkdir(parent, { recursive: true })
    let movedPrevious = false
    try {
      await fs.rename(options.destination, backup)
      movedPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      await fs.rename(extracted, options.destination)
      const installedExecutable = path.join(options.destination, manifest.executable)
      await Promise.all([
        fs.writeFile(path.join(options.destination, "executable"), `${installedExecutable}\n`, {
          flag: "wx",
          mode: 0o600,
        }),
        fs.writeFile(path.join(options.destination, "manifest.json"), manifestText, { flag: "wx", mode: 0o600 }),
      ])
      if (movedPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
      return {
        action: hadExistingInstall || options.force ? "reinstalled" : "installed",
        executablePath: installedExecutable,
        browserVersion: manifest.browserVersion,
        revision: manifest.revision,
        downloadBytes: artifact.byteLength,
      }
    } catch (error) {
      await fs.rm(options.destination, { recursive: true, force: true })
      if (movedPrevious) await fs.rename(backup, options.destination)
      throw error
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

async function installedChromium(
  destination: string,
  expected?: { version: string; platform: ChromiumReleasePlatform; arch: ChromiumReleaseArch },
): Promise<Omit<ChromiumInstallReport, "action" | "downloadBytes"> | null> {
  try {
    const marker = path.join(destination, "executable")
    const markerStat = await fs.lstat(marker)
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return null
    const target = (await fs.readFile(marker, "utf8")).trim()
    const real = await fs.realpath(target)
    const realDestination = await fs.realpath(destination)
    const stat = await fs.lstat(real)
    if (!isPathContained(realDestination, real) || !stat.isFile() || stat.isSymbolicLink()) return null
    const manifest = ChromiumManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8")),
    )
    if (
      expected &&
      (manifest.version !== expected.version ||
        manifest.platform !== expected.platform ||
        manifest.arch !== expected.arch)
    ) {
      return null
    }
    return { executablePath: real, browserVersion: manifest.browserVersion, revision: manifest.revision }
  } catch {
    return null
  }
}

function unsupportedChromium(platform: string, arch: string, libc: string): Error {
  return new Error(
    `Managed Chromium installation is unsupported on ${platform} ${arch} ${libc}. Install Chromium manually and set CHROMIUM_PATH.`,
  )
}

async function discoverChromiumWithSource(
  options: {
    platform?: NodeJS.Platform
    arch?: string
    home?: string
    env?: Record<string, string | undefined>
    managedDir?: string
    playwrightCoreExecutable?: () => Promise<string | null>
  } = {},
): Promise<{ path: string; source: ChromiumDiscoverySource } | null> {
  const platform = options.platform ?? os.platform()
  const arch = options.arch ?? os.arch()
  const home = options.home ?? os.homedir()
  const env = options.env ?? Bun.env
  if (env.CHROMIUM_PATH && (await fileExists(env.CHROMIUM_PATH))) return { path: env.CHROMIUM_PATH, source: "env" }
  const managedDir = options.managedDir ?? BrowserInstall.chromiumDir()
  const managedInstall = await installedChromium(managedDir)
  if (managedInstall) return { path: managedInstall.executablePath, source: "managed" }
  const managed = await findChromiumInDir(managedDir)
  if (managed) return { path: managed, source: "managed" }
  const cache =
    platform === "darwin"
      ? path.join(home, "Library", "Caches", "ms-playwright")
      : platform === "win32"
        ? path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright")
        : path.join(home, ".cache", "ms-playwright")
  const playwright = await findPlaywrightChromium(cache, platform, arch)
  if (playwright) return { path: playwright, source: "playwright" }
  try {
    const executable = options.playwrightCoreExecutable
      ? await options.playwrightCoreExecutable()
      : (await import("playwright-core")).chromium.executablePath()
    if (executable && (await fileExists(executable))) return { path: executable, source: "playwright-core" }
  } catch {}
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [
            path.join(env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(
              env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
            path.join(
              env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
            path.join(env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
          ]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
  for (const candidate of candidates) if (await fileExists(candidate)) return { path: candidate, source: "system" }
  return null
}

async function launchChromiumProbe(executablePath: string): Promise<void> {
  const { chromium } = await import("playwright")
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    timeout: 10_000,
    args: BrowserInstall.chromiumLaunchArgs(),
  })
  await browser.close()
}

async function chromiumVersion(executablePath: string): Promise<string> {
  return runDiagnosticCommand([executablePath, "--version"], 5_000)
}

async function chromiumLdd(executablePath: string): Promise<string> {
  return runDiagnosticCommand(["ldd", executablePath], 10_000)
}

async function runDiagnosticCommand(command: string[], timeout: number): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeout)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) throw new Error(stderr.trim() || `${command[0]} exited with code ${exitCode}.`)
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > maxBytes) throw new Error("Browser artifact metadata response is too large.")
  if (!response.body) throw new Error("Browser artifact metadata response has no body.")
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error("Browser artifact metadata response is too large.")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total).toString("utf8")
}

async function boundedBytes(response: Response, expectedBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length && length !== expectedBytes) throw new Error("Browser artifact size does not match its manifest.")
  if (!response.body) throw new Error("Browser artifact response has no body.")
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > expectedBytes) {
      await reader.cancel()
      throw new Error("Browser artifact exceeds its signed size.")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

async function verifyManifest(text: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", Buffer.from(publicKey, "base64"), { name: "Ed25519" }, false, [
      "verify",
    ])
    return crypto.subtle.verify("Ed25519", key, Buffer.from(signature, "base64"), Buffer.from(text))
  } catch {
    return false
  }
}

async function extractSafeZip(archivePath: string, destination: string): Promise<void> {
  const archive = await unzipper.Open.file(archivePath)
  if (archive.files.length > 100_000) throw new Error("Browser artifact archive contains too many entries.")
  let totalBytes = 0
  for (const entry of archive.files) {
    const normalized = entry.path.replace(/\\/g, "/").normalize("NFC")
    if (
      !normalized ||
      normalized.length > 4_096 ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Browser artifact archive contains an unsafe path: ${entry.path}`)
    }
    const mode = Number(entry.externalFileAttributes ?? 0) >>> 16
    const fileType = mode & 0o170000
    if (fileType && fileType !== 0o040000 && fileType !== 0o100000 && fileType !== 0o120000) {
      throw new Error(`Browser artifact archive contains an unsupported file type: ${entry.path}`)
    }
    const target = path.resolve(destination, normalized)
    if (!isPathContained(destination, target))
      throw new Error(`Browser artifact archive escapes extraction root: ${entry.path}`)
    if (entry.type === "Directory") {
      await fs.mkdir(target, { recursive: true, mode: 0o755 })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (fileType === 0o120000) {
      if (entry.uncompressedSize > 4_096) {
        throw new Error(`Browser artifact archive symlink target is too large: ${entry.path}`)
      }
      const linkTarget = (await entry.buffer()).toString("utf8")
      totalBytes += Buffer.byteLength(linkTarget)
      if (totalBytes > 1024 * 1024 * 1024) throw new Error("Browser artifact archive exceeds the extraction limit.")
      if (!linkTarget || path.isAbsolute(linkTarget) || linkTarget.includes("\0")) {
        throw new Error(`Browser artifact archive symlink is invalid: ${entry.path}`)
      }
      const resolvedLink = path.resolve(path.dirname(target), linkTarget)
      if (!isPathContained(destination, resolvedLink)) {
        throw new Error(`Browser artifact archive symlink escapes extraction root: ${entry.path}`)
      }
      await fs.symlink(linkTarget, target)
      continue
    }
    const handle = await fs.open(target, "wx")
    try {
      for await (const chunk of entry.stream()) {
        const data = Buffer.from(chunk)
        totalBytes += data.byteLength
        if (totalBytes > 1024 * 1024 * 1024) throw new Error("Browser artifact archive exceeds the extraction limit.")
        await handle.write(data)
      }
    } finally {
      await handle.close()
    }
    await fs.chmod(target, mode & 0o111 ? 0o755 : 0o644)
  }
}
