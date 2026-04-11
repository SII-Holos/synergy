#!/usr/bin/env bun

import { configureNpmAuth, loadReleaseState } from "./shared/runtime"
import { finalizeGitHubRelease } from "./nodes/finalize-github-release"
import { promoteLatest, verifyLatest } from "./nodes/promote-latest"
import { verifyDraftAssets } from "./nodes/verify-draft-assets"
import { verifyRegistryCandidate } from "./nodes/verify-registry-candidate"

const version = process.env.SYNERGY_VERSION?.trim()
if (!version) {
  throw new Error("stable-complete requires SYNERGY_VERSION")
}

await configureNpmAuth()
const state = await loadReleaseState("stable", version)
const extraPackages = state.registryPackages.filter((name) =>
  /^@ericsanchezok\/synergy-(darwin|linux|windows)-/.test(name),
)
await verifyRegistryCandidate(state.version, state.channel, extraPackages)
await verifyDraftAssets(state)
await promoteLatest(state.version, extraPackages)
await verifyLatest(state.version, extraPackages)
await finalizeGitHubRelease(state)
