import { $ } from "bun"

let cachedRemoteUrl: string | null = null

export async function currentGitRemoteUrl() {
  if (cachedRemoteUrl) return cachedRemoteUrl
  cachedRemoteUrl = (await $`git remote get-url origin`.text()).trim()
  if (!cachedRemoteUrl) {
    throw new Error("failed to resolve origin remote url")
  }
  return cachedRemoteUrl
}
