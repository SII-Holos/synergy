import { buildNotes, getLatestRelease } from "../../changelog"
import { applyReleaseMetadata, createDraftRelease, viewRelease } from "../shared/github"
import { type ReleaseState } from "../shared/packages"

export async function ensureDraftRelease(state: ReleaseState) {
  if (!state.releaseTag) return state

  const existing = await viewRelease(state.releaseTag)
  if (existing) {
    console.log(`reusing existing GitHub release ${state.releaseTag}`)
    return applyReleaseMetadata(state, existing)
  }

  const previous = await getLatestRelease()
  const notes = previous ? await buildNotes(previous, "HEAD") : ["Initial release"]
  const release = await createDraftRelease(state.releaseTag, state.releaseTag, notes.join("\n") || "No notable changes")
  return applyReleaseMetadata(state, release)
}
