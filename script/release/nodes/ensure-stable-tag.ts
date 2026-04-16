import { $ } from "bun"
import { currentRepo } from "../../shared/current-repo"
import { releaseTag, retry } from "../shared/runtime"

async function localTagExists(tag: string) {
  const result = await $`git rev-parse --verify refs/tags/${tag}`.nothrow().quiet()
  return result.exitCode === 0
}

async function remoteTagExists(tag: string) {
  const repo = await currentRepo()
  const result = await $`gh api /repos/${repo}/git/ref/tags/${tag}`.nothrow().quiet()
  return result.exitCode === 0
}

export async function ensureStableTag(version: string) {
  const tag = releaseTag(version)
  console.log(`\n=== ensure stable git tag ${tag} ===\n`)

  if (!(await localTagExists(tag))) {
    await $`git tag ${tag}`
  }

  if (!(await remoteTagExists(tag))) {
    await retry(() => $`git push origin ${tag}`)
  }

  return tag
}
