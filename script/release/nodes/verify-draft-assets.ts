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
}
