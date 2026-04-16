import { finalizeRelease } from "../shared/github"
import { type ReleaseState } from "../shared/packages"

export async function finalizeGitHubRelease(state: ReleaseState) {
  if (!state.releaseTag) return
  console.log("\n=== finalize github release ===\n")
  await finalizeRelease(state.releaseTag)
}
