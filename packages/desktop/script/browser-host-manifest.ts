#!/usr/bin/env bun
import { createHash, createPrivateKey, sign } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser"
import {
  browserHostArtifactName,
  browserHostManifestName,
  browserHostManifestSignatureName,
  type DesktopReleaseArch,
  type DesktopReleasePlatform,
} from "../src/release-assets.js"

const releaseDir = path.resolve(process.argv[2] ?? "release/browser-host")
const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as { version: string }
const version = process.env.SYNERGY_VERSION?.trim() || packageJson.version
const platform = process.platform as DesktopReleasePlatform
const baseUrl =
  process.env.SYNERGY_BROWSER_HOST_RELEASE_BASE_URL ??
  `https://github.com/SII-Holos/synergy/releases/download/v${version}`
const signingKey = process.env.SYNERGY_BROWSER_HOST_SIGNING_KEY
if (!signingKey) throw new Error("SYNERGY_BROWSER_HOST_SIGNING_KEY is required to sign the Browser Host manifest.")
const privateKey = createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" })
await fs.mkdir(releaseDir, { recursive: true })
for (const arch of ["x64", "arm64"] satisfies DesktopReleaseArch[]) {
  const name = browserHostArtifactName(version, platform, arch)
  const filepath = path.join(releaseDir, name)
  const data = await fs.readFile(filepath)
  const executable =
    platform === "darwin"
      ? "Synergy Browser Host.app/Contents/MacOS/Synergy Browser Host"
      : platform === "win32"
        ? "Synergy Browser Host.exe"
        : "synergy-browser-host"
  const manifest = {
    version,
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    platform,
    arch,
    name,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.byteLength,
    url: `${baseUrl}/${name}`,
    executable,
  }
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`
  const signature = sign(null, Buffer.from(encoded), privateKey).toString("base64")
  await fs.writeFile(path.join(releaseDir, browserHostManifestName(version, platform, arch)), encoded)
  await fs.writeFile(path.join(releaseDir, browserHostManifestSignatureName(version, platform, arch)), `${signature}\n`)
}
