import { uploadReleaseAsset } from "../shared/github"
import { type ReleaseState } from "../shared/packages"

export async function uploadBinaryAssets(state: ReleaseState) {
  if (!state.releaseTag) {
    return
  }
  console.log("\n=== upload binary assets ===\n")
  for (const assetPath of state.binaryAssets) {
    await uploadReleaseAsset(state.releaseTag, assetPath)
  }
}
