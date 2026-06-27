import path from "path"
import { viewRelease } from "../shared/github"
import { type ReleaseState } from "../shared/packages"

export async function verifyDraftAssets(state: ReleaseState) {
  if (!state.releaseTag) return
  console.log("\n=== verify draft assets ===\n")
  const release = await viewRelease(state.releaseTag)
  if (!release) {
    throw new Error(`expected draft release ${state.releaseTag} to exist`)
  }
  const names = new Set(release.assets.map((asset) => asset.name))
  for (const assetPath of state.binaryAssets) {
    const assetName = path.basename(assetPath)
    if (!names.has(assetName)) {
      throw new Error(`missing draft release asset ${assetName}`)
    }
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
