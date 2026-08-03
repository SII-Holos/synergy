import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  desktopChecksumsName,
  desktopPortableArtifactNames,
  expectedBrowserHostArtifacts,
  expectedChromiumManifestArtifacts,
  expectedDesktopPrimaryArtifacts,
} from "../../../packages/desktop/src/release-assets"
import { downloadReleaseAsset, viewRelease } from "../shared/github"
import type { ReleaseState } from "../shared/packages"

export const EXPECTED_UPDATE_METADATA = ["latest-mac.yml", "latest.yml", "latest-linux.yml", "latest-linux-arm64.yml"]

export async function verifyDesktopDraftAssets(state: ReleaseState) {
  if (!state.releaseTag) return
  console.log("\n=== verify desktop draft assets ===\n")
  const release = await viewRelease(state.releaseTag)
  if (!release) {
    throw new Error(`expected draft release ${state.releaseTag} to exist`)
  }
  const names = new Set(release.assets.map((asset) => asset.name))
  assertDesktopAssetNames(state.version, names)
  await verifyPublishedDesktopChecksums(state, downloadReleaseAsset, names)
}

export function assertDesktopAssetNames(version: string, names: ReadonlySet<string>): void {
  for (const assetName of expectedDesktopPrimaryArtifacts(version)) {
    if (!names.has(assetName)) {
      throw new Error(`missing desktop release asset ${assetName}`)
    }
  }
  for (const assetName of desktopPortableArtifactNames(version)) {
    if (!names.has(assetName)) {
      throw new Error(`missing desktop portable asset ${assetName}`)
    }
  }
  for (const assetName of expectedBrowserHostArtifacts(version)) {
    if (!names.has(assetName)) {
      throw new Error(`missing Browser Host release asset ${assetName}`)
    }
  }
  for (const assetName of expectedChromiumManifestArtifacts(version)) {
    if (!names.has(assetName)) {
      throw new Error(`missing Chromium manifest release asset ${assetName}`)
    }
  }
  const checksums = desktopChecksumsName(version)
  if (!names.has(checksums)) {
    throw new Error(`missing desktop checksum asset ${checksums}`)
  }
  for (const metadata of EXPECTED_UPDATE_METADATA) {
    if (!names.has(metadata)) {
      throw new Error(`missing desktop updater metadata ${metadata}`)
    }
  }
}

export function expectedDesktopChecksumAssetNames(version: string): string[] {
  return [
    ...expectedDesktopPrimaryArtifacts(version),
    ...desktopPortableArtifactNames(version),
    ...expectedBrowserHostArtifacts(version),
    ...expectedChromiumManifestArtifacts(version),
    ...EXPECTED_UPDATE_METADATA,
  ]
}

export function assertDesktopAssetChecksums(
  manifest: string,
  assetHashes: ReadonlyMap<string, string>,
  expectedNames: Iterable<string>,
  uploadedNames?: ReadonlySet<string>,
): void {
  const manifestHashes = new Map<string, string>()
  const lines = manifest.split("\n")
  for (const [index, line] of lines.entries()) {
    if (line === "" && index === lines.length - 1) continue
    const match = /^([a-f0-9]{64})  ([^/\\\s]+)$/.exec(line)
    if (!match) throw new Error(`invalid desktop checksum line ${index + 1}`)
    const hash = match[1]!
    const assetName = match[2]!
    if (manifestHashes.has(assetName)) throw new Error(`duplicate desktop checksum for ${assetName}`)
    if (uploadedNames && !uploadedNames.has(assetName)) {
      throw new Error(`unexpected desktop checksum for ${assetName}`)
    }
    manifestHashes.set(assetName, hash)
  }

  for (const assetName of expectedNames) {
    const expectedHash = manifestHashes.get(assetName)
    if (!expectedHash) throw new Error(`missing desktop checksum for ${assetName}`)
    const actualHash = assetHashes.get(assetName)
    if (!actualHash) throw new Error(`missing downloaded desktop asset ${assetName}`)
    if (actualHash !== expectedHash) throw new Error(`desktop checksum mismatch for ${assetName}`)
  }
}

export async function verifyPublishedDesktopChecksums(
  state: ReleaseState,
  download: typeof downloadReleaseAsset = downloadReleaseAsset,
  uploadedNames?: ReadonlySet<string>,
): Promise<void> {
  if (!state.releaseTag) return
  const expectedNames = expectedDesktopChecksumAssetNames(state.version)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-release-checksums-"))
  try {
    const checksumName = desktopChecksumsName(state.version)
    const checksumPath = path.join(directory, checksumName)
    await download(state.releaseTag, checksumName, checksumPath)
    const hashes = new Map<string, string>()
    await Promise.all(
      expectedNames.map(async (assetName) => {
        const downloadedPath = path.join(directory, assetName)
        await download(state.releaseTag!, assetName, downloadedPath)
        hashes.set(assetName, await sha256File(downloadedPath))
      }),
    )
    assertDesktopAssetChecksums(await fs.readFile(checksumPath, "utf8"), hashes, expectedNames, uploadedNames)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of Bun.file(filePath).stream()) hash.update(chunk)
  return hash.digest("hex")
}
