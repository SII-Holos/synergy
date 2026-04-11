import { $ } from "bun"
import { currentRepo } from "../../shared/current-repo"
import { type ReleaseState } from "./packages"
import { releaseEnv } from "./runtime"

export async function viewRelease(tag: string) {
  const repo = await currentRepo()
  const result = await $`gh release view ${tag} --repo ${repo} --json id,tagName,isDraft,assets`
    .env(releaseEnv())
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) return null
  return result.json() as {
    id: string
    tagName: string
    isDraft: boolean
    assets: Array<{ name: string }>
  }
}

export async function createDraftRelease(tag: string, title: string, notes: string) {
  const repo = await currentRepo()
  await $`gh release create ${tag} --repo ${repo} --title ${title} --notes ${notes} --draft --verify-tag`.env(
    releaseEnv(),
  )
  return await viewRelease(tag)
}

export async function uploadReleaseAsset(tag: string, assetPath: string) {
  const repo = await currentRepo()
  await $`gh release upload ${tag} ${assetPath} --repo ${repo} --clobber`.env(releaseEnv())
}

export async function finalizeRelease(tag: string) {
  const repo = await currentRepo()
  await $`gh release edit ${tag} --repo ${repo} --draft=false`.env(releaseEnv())
}

export function applyReleaseMetadata(state: ReleaseState, release: { id: string; tagName: string } | null) {
  if (!release) return state
  state.githubReleaseID = release.id
  state.githubReleaseTagName = release.tagName
  return state
}
