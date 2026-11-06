#!/usr/bin/env bun

import { FIXED_REGISTRY_PACKAGES } from "./shared/packages"
import { configureNpmAuth, loadReleaseState } from "./shared/runtime"
import { finalizeGitHubRelease } from "./nodes/finalize-github-release"
import { promoteLatest, verifyLatest } from "./nodes/promote-latest"
import { verifyDraftAssets } from "./nodes/verify-draft-assets"
import { verifyDesktopDraftAssets } from "./nodes/verify-desktop-assets"
import { verifyRegistryCandidate } from "./nodes/verify-registry-candidate"

const version = process.env.SYNERGY_VERSION?.trim()
if (!version) {
  throw new Error("stable-complete requires SYNERGY_VERSION")
}

await configureNpmAuth()
const state = await loadReleaseState("stable", version)
const extraPackages = state.registryPackages.filter((name) => !FIXED_REGISTRY_PACKAGES.includes(name))
await verifyRegistryCandidate(state.version, state.channel, extraPackages)
await verifyDraftAssets(state)
await verifyDesktopDraftAssets(state)
await promoteLatest(state.version, extraPackages)
await verifyLatest(state.version, extraPackages)
await finalizeGitHubRelease(state)
