#!/usr/bin/env bun
import { createHash, createPrivateKey, sign } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  ChromiumManifestSchema,
  chromiumManifestName,
  chromiumManifestSignatureName,
  chromiumReleaseTarget,
  type ChromiumReleaseArch,
  type ChromiumReleasePlatform,
} from "@ericsanchezok/synergy-browser"

interface PlaywrightBrowsers {
  browsers: Array<{
    name: string
    revision: string
    browserVersion?: string
  }>
}

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
const PLAYWRIGHT_DOWNLOAD_ORIGINS = [
  "https://cdn.playwright.dev/dbazure/download/playwright",
  "https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
]
const releaseDir = path.resolve(process.argv[2] ?? "release/chromium")
const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as { version: string }
const version = process.env.SYNERGY_VERSION?.trim() || packageJson.version
const signingKey = process.env.SYNERGY_BROWSER_MANIFEST_SIGNING_KEY ?? process.env.SYNERGY_BROWSER_HOST_SIGNING_KEY
if (!signingKey) throw new Error("SYNERGY_BROWSER_MANIFEST_SIGNING_KEY is required to sign Chromium manifests.")
const privateKey = createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" })
const platform = process.platform
if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
  throw new Error(`Chromium release manifests are unavailable on ${platform}.`)
}
const metadataPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../synergy/node_modules/playwright-core/browsers.json",
)
const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as PlaywrightBrowsers
const chromium = metadata.browsers.find((browser) => browser.name === "chromium")
if (!chromium?.browserVersion) throw new Error("Playwright Chromium metadata is incomplete.")
const arches: ChromiumReleaseArch[] = platform === "win32" ? ["x64"] : ["x64", "arm64"]
await fs.mkdir(releaseDir, { recursive: true })

for (const arch of arches) {
  const target = chromiumReleaseTarget(platform, arch, chromium.browserVersion, chromium.revision)
  if (!target) throw new Error(`Chromium release target is unavailable for ${platform} ${arch}.`)
  const artifact = await inspectArtifact(target.path)
  const manifest = ChromiumManifestSchema.parse({
    version,
    platform,
    arch,
    name: target.name,
    sha256: artifact.sha256,
    size: artifact.size,
    url: artifact.url,
    executable: target.executable,
    browserVersion: chromium.browserVersion,
    revision: chromium.revision,
  })
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`
  const signature = sign(null, Buffer.from(encoded), privateKey).toString("base64")
  await Promise.all([
    fs.writeFile(path.join(releaseDir, chromiumManifestName(version, platform, arch)), encoded),
    fs.writeFile(path.join(releaseDir, chromiumManifestSignatureName(version, platform, arch)), `${signature}\n`),
  ])
}

async function inspectArtifact(artifactPath: string): Promise<{ url: string; sha256: string; size: number }> {
  const failures: string[] = []
  for (const origin of PLAYWRIGHT_DOWNLOAD_ORIGINS) {
    const url = `${origin}/${artifactPath}`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!response.ok || !response.body) {
        failures.push(`${url}: HTTP ${response.status}`)
        continue
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0)
      if (contentLength > MAX_ARCHIVE_BYTES) throw new Error("artifact exceeds the manifest size limit")
      const digest = createHash("sha256")
      const reader = response.body.getReader()
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_ARCHIVE_BYTES) {
          await reader.cancel()
          throw new Error("artifact exceeds the manifest size limit")
        }
        digest.update(value)
      }
      if (contentLength && size !== contentLength) throw new Error("artifact size does not match Content-Length")
      return { url, sha256: digest.digest("hex"), size }
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Unable to inspect Chromium artifact. ${failures.join("; ")}`)
}
