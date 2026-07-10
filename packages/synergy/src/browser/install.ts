import path from "path"
import os from "os"
import fs from "fs/promises"
import { createHash } from "node:crypto"
import z from "zod"
import unzipper from "unzipper"
import { Global } from "../global/index.js"
import { Installation } from "../global/installation.js"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser"
import { isPathContained } from "../util/path-contain.js"

declare global {
  const SYNERGY_BROWSER_HOST_PUBLIC_KEY: string
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
    url: z.string().url().max(20_000),
    executable: z.string().min(1).max(20_000),
  })
  .strict()

export type BrowserHostManifest = z.infer<typeof HostManifest>
const hostInstalls = new Map<string, Promise<string>>()

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
  export function chromiumDir(): string {
    return path.join(Global.Path.data, "browser", "chromium")
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
      request(`${base}/${name}`),
      request(`${base}/${name}.sig`),
    ])
    if (!manifestResponse.ok || !signatureResponse.ok)
      throw new Error("Browser Host manifest is unavailable for this Synergy release.")
    const manifestText = await boundedText(manifestResponse, 128 * 1024)
    const signature = (await boundedText(signatureResponse, 16 * 1024)).trim()
    const publicKey =
      options.publicKey ?? (typeof SYNERGY_BROWSER_HOST_PUBLIC_KEY === "string" ? SYNERGY_BROWSER_HOST_PUBLIC_KEY : "")
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
    const artifactResponse = await request(manifest.url)
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
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > maxBytes) throw new Error("Browser Host metadata response is too large.")
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Browser Host metadata response is too large.")
  return text
}

async function boundedBytes(response: Response, expectedBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length && length !== expectedBytes) throw new Error("Browser Host artifact size does not match its manifest.")
  if (!response.body) throw new Error("Browser Host artifact response has no body.")
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > expectedBytes) {
      await reader.cancel()
      throw new Error("Browser Host artifact exceeds its signed size.")
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
  if (archive.files.length > 100_000) throw new Error("Browser Host archive contains too many entries.")
  let totalBytes = 0
  for (const entry of archive.files) {
    const normalized = entry.path.replace(/\\/g, "/").normalize("NFC")
    if (
      !normalized ||
      normalized.length > 4_096 ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Browser Host archive contains an unsafe path: ${entry.path}`)
    }
    const mode = Number(entry.externalFileAttributes ?? 0) >>> 16
    const fileType = mode & 0o170000
    if (fileType && fileType !== 0o040000 && fileType !== 0o100000 && fileType !== 0o120000) {
      throw new Error(`Browser Host archive contains an unsupported file type: ${entry.path}`)
    }
    const target = path.resolve(destination, normalized)
    if (!isPathContained(destination, target))
      throw new Error(`Browser Host archive escapes extraction root: ${entry.path}`)
    if (entry.type === "Directory") {
      await fs.mkdir(target, { recursive: true, mode: 0o755 })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (fileType === 0o120000) {
      if (entry.uncompressedSize > 4_096) {
        throw new Error(`Browser Host archive symlink target is too large: ${entry.path}`)
      }
      const linkTarget = (await entry.buffer()).toString("utf8")
      totalBytes += Buffer.byteLength(linkTarget)
      if (totalBytes > 1024 * 1024 * 1024) throw new Error("Browser Host archive exceeds the extraction limit.")
      if (!linkTarget || path.isAbsolute(linkTarget) || linkTarget.includes("\0")) {
        throw new Error(`Browser Host archive symlink is invalid: ${entry.path}`)
      }
      const resolvedLink = path.resolve(path.dirname(target), linkTarget)
      if (!isPathContained(destination, resolvedLink)) {
        throw new Error(`Browser Host archive symlink escapes extraction root: ${entry.path}`)
      }
      await fs.symlink(linkTarget, target)
      continue
    }
    const handle = await fs.open(target, "wx")
    try {
      for await (const chunk of entry.stream()) {
        const data = Buffer.from(chunk)
        totalBytes += data.byteLength
        if (totalBytes > 1024 * 1024 * 1024) throw new Error("Browser Host archive exceeds the extraction limit.")
        await handle.write(data)
      }
    } finally {
      await handle.close()
    }
    await fs.chmod(target, mode & 0o111 ? 0o755 : 0o644)
  }
}
