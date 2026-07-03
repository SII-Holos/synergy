import {
  desktopChecksumsName,
  desktopPortableArtifactNames,
  expectedDesktopPrimaryArtifacts,
} from "../../../packages/desktop/src/release-assets"
import { viewRelease } from "../shared/github"
import type { ReleaseState } from "../shared/packages"

const EXPECTED_UPDATE_METADATA = ["latest-mac.yml", "latest.yml", "latest-linux.yml"]

export async function verifyDesktopDraftAssets(state: ReleaseState) {
  if (!state.releaseTag) return
  console.log("\n=== verify desktop draft assets ===\n")
  const release = await viewRelease(state.releaseTag)
  if (!release) {
    throw new Error(`expected draft release ${state.releaseTag} to exist`)
  }
  const names = new Set(release.assets.map((asset) => asset.name))
  for (const assetName of expectedDesktopPrimaryArtifacts(state.version)) {
    if (!names.has(assetName)) {
      throw new Error(`missing desktop release asset ${assetName}`)
    }
  }
  for (const assetName of desktopPortableArtifactNames(state.version)) {
    if (!names.has(assetName)) {
      throw new Error(`missing desktop portable asset ${assetName}`)
    }
  }
  const checksums = desktopChecksumsName(state.version)
  if (!names.has(checksums)) {
    throw new Error(`missing desktop checksum asset ${checksums}`)
  }
  for (const metadata of EXPECTED_UPDATE_METADATA) {
    if (!names.has(metadata)) {
      throw new Error(`missing desktop updater metadata ${metadata}`)
    }
  }
}
