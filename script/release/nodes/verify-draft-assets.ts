import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { downloadReleaseAsset, viewRelease } from "../shared/github"
import { validatePackagedRuntimeArchive } from "./package-binary-assets"
import { type ReleaseState } from "../shared/packages"

export async function verifyDraftAssets(state: ReleaseState) {
  if (!state.releaseTag) return
  console.log("\n=== verify draft assets ===\n")
  const release = await viewRelease(state.releaseTag)
  if (!release) {
    throw new Error(`expected draft release ${state.releaseTag} to exist`)
  }
  assertDraftAssetNames(
    state,
    release.assets.map((asset) => asset.name),
  )
  await verifyPublishedBinaryChecksums(state)
}

export function assertDraftAssetNames(state: ReleaseState, assetNames: Iterable<string>) {
  const names = new Set(assetNames)
  for (const assetPath of state.binaryAssets) {
    const assetName = path.basename(assetPath)
    if (!names.has(assetName)) {
      throw new Error(`missing draft release asset ${assetName}`)
    }
  }
  if (state.binaryAssets.length > 0 && !state.binaryChecksums) {
    throw new Error("missing CLI checksum path for draft release")
  }
  if (state.binaryChecksums && !names.has(path.basename(state.binaryChecksums))) {
    throw new Error(`missing draft release CLI checksum ${path.basename(state.binaryChecksums)}`)
  }
  for (const assetPath of state.desktopAssets) {
    const assetName = path.basename(assetPath)
    if (!names.has(assetName)) {
      throw new Error(`missing draft release desktop asset ${assetName}`)
    }
  }
  if (state.desktopChecksums && !names.has(path.basename(state.desktopChecksums))) {
    throw new Error(`missing draft release desktop checksum ${path.basename(state.desktopChecksums)}`)
  }
  for (const metadata of state.desktopUpdateMetadata) {
    if (!names.has(metadata)) {
      throw new Error(`missing draft release desktop update metadata ${metadata}`)
    }
  }
}

export async function verifyPublishedBinaryChecksums(
  state: ReleaseState,
  download: typeof downloadReleaseAsset = downloadReleaseAsset,
  validate: typeof validatePackagedRuntimeArchive = validatePackagedRuntimeArchive,
): Promise<void> {
  if (!state.releaseTag || state.binaryAssets.length === 0 || !state.binaryChecksums) return
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-release-checksums-"))
  try {
    const checksumName = path.basename(state.binaryChecksums)
    const checksumPath = path.join(directory, checksumName)
    await download(state.releaseTag, checksumName, checksumPath)
    const hashes = new Map<string, string>()
    const runtimeArchives: Array<{ path: string; target: string }> = []
    for (const assetPath of state.binaryAssets) {
      const assetName = path.basename(assetPath)
      const downloadedPath = path.join(directory, assetName)
      await download(state.releaseTag, assetName, downloadedPath)
      hashes.set(assetName, await sha256File(downloadedPath))
      const target = runtimeTargetFromArchiveName(assetName)
      if (target) runtimeArchives.push({ path: downloadedPath, target })
    }
    assertBinaryAssetChecksums(await fs.readFile(checksumPath, "utf8"), hashes)
    for (const archive of runtimeArchives) await validate(archive.path, archive.target)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

export function assertBinaryAssetChecksums(manifest: string, assetHashes: ReadonlyMap<string, string>): void {
  const expected = new Map<string, string>()
  const lines = manifest.split("\n")
  for (const [index, line] of lines.entries()) {
    if (line === "" && index === lines.length - 1) continue
    const match = /^([a-f0-9]{64})  ([^/\\\s]+)$/.exec(line)
    if (!match) throw new Error(`invalid CLI checksum line ${index + 1}`)
    const hash = match[1]!
    const assetName = match[2]!
    if (expected.has(assetName)) throw new Error(`duplicate CLI checksum for ${assetName}`)
    expected.set(assetName, hash)
  }
  for (const [assetName, actualHash] of assetHashes) {
    const expectedHash = expected.get(assetName)
    if (!expectedHash) throw new Error(`missing CLI checksum for ${assetName}`)
    if (actualHash !== expectedHash) throw new Error(`CLI checksum mismatch for ${assetName}`)
    expected.delete(assetName)
  }
  const unexpected = expected.keys().next().value
  if (unexpected) throw new Error(`unexpected CLI checksum for ${unexpected}`)
}

function runtimeTargetFromArchiveName(assetName: string): string | undefined {
  const target = assetName.endsWith(".tar.gz")
    ? assetName.slice(0, -".tar.gz".length)
    : assetName.endsWith(".zip")
      ? assetName.slice(0, -".zip".length)
      : undefined
  if (!target || !/^synergy-(linux|darwin|windows)-(?:x64|arm64)(?:-|$)/.test(target)) return
  return target
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of Bun.file(filePath).stream()) hash.update(chunk)
  return hash.digest("hex")
}
