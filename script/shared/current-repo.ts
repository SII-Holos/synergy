#!/usr/bin/env bun

import { $ } from "bun"

let cachedRepo: string | null = null

export async function currentRepo() {
  if (cachedRepo) return cachedRepo
  const override = process.env.SYNERGY_RELEASE_REPO?.trim()
  if (override) {
    cachedRepo = override
    return cachedRepo
  }
  const githubRepository = process.env.GITHUB_REPOSITORY?.trim()
  if (githubRepository) {
    cachedRepo = githubRepository
    return cachedRepo
  }
  cachedRepo = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim()
  if (!cachedRepo) {
    throw new Error("failed to resolve current GitHub repository")
  }
  return cachedRepo
}
