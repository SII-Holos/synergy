#!/usr/bin/env bun

import { createReleaseState, summarizeState } from "./shared/context"
import { snapshotFiles, restoreFiles } from "./shared/files"
import { VERSION_MANAGED_PACKAGE_PATHS, PRESETS_DIST_DIR } from "./shared/packages"
import { computeStableVersion, configureNpmAuth, saveReleaseState } from "./shared/runtime"
import { rewriteVersions } from "./shared/versions"
import { bunInstall } from "./nodes/bun-install"
import { buildApp } from "./nodes/build-app"
import { buildDesktop } from "./nodes/build-desktop"
import { generateSchema } from "./nodes/generate-schema"
import { generateSdk } from "./nodes/generate-sdk"
import { buildUtil } from "./nodes/build-util"
import { buildPlugin } from "./nodes/build-plugin"
import { buildPluginKit } from "./nodes/build-plugin-kit"
import { buildSynergyBinaries } from "./nodes/build-synergy-binaries"
import { prepareSynergyPackages } from "./nodes/prepare-synergy-packages"
import { validateLocalArtifacts } from "./nodes/validate-local-artifacts"
import { publishModuleCandidates } from "./shared/publish-modules"
import { publishSynergyCandidate } from "./nodes/publish-synergy-candidate"
import { createBinaryChecksums, packageBinaryAssets } from "./nodes/package-binary-assets"
import { ensureDraftRelease } from "./nodes/create-draft-release"
import { ensureStableTag } from "./nodes/ensure-stable-tag"
import { uploadBinaryAssets } from "./nodes/upload-binary-assets"
import { verifyRegistryCandidate } from "./nodes/verify-registry-candidate"
import { verifyDraftAssets } from "./nodes/verify-draft-assets"

const bump = process.env.SYNERGY_BUMP?.trim()
if (!bump || !["patch", "minor", "major"].includes(bump)) {
  throw new Error("stable-start requires SYNERGY_BUMP=patch|minor|major")
}

const version = await computeStableVersion(bump)
const state = createReleaseState({
  kind: "stable",
  version,
  channel: "next",
  promoteTag: "latest",
})

const snapshot = await snapshotFiles(VERSION_MANAGED_PACKAGE_PATHS)

try {
  await rewriteVersions(version)
  await configureNpmAuth()
  await bunInstall()
  await Promise.all([generateSchema(), generateSdk(), buildUtil()])
  await buildPlugin()
  await buildPluginKit()
  await buildApp()
  await buildDesktop()
  const platformNames = await buildSynergyBinaries(version, "stable")
  const platformPackages = await prepareSynergyPackages(version, platformNames)
  await validateLocalArtifacts(platformNames)

  const modules = await publishModuleCandidates(version, state.channel)
  const synergy = await publishSynergyCandidate(version, state.channel)

  state.registryPackages = [...new Set([...state.registryPackages, ...modules, ...platformPackages])]
  const synergyAssets = await packageBinaryAssets(PRESETS_DIST_DIR, synergy.platformNames)
  state.binaryAssets = synergyAssets
  state.binaryChecksums = await createBinaryChecksums(version, state.binaryAssets, PRESETS_DIST_DIR)
  await ensureStableTag(state.version)

  const withRelease = await ensureDraftRelease(state)
  Object.assign(state, withRelease)
  await uploadBinaryAssets(state)
  await verifyRegistryCandidate(version, state.channel, platformPackages)
  await verifyDraftAssets(state)
  await saveReleaseState(state)

  const summary = summarizeState(state)
  console.log("release state", JSON.stringify(summary, null, 2))

  let output = `version=${state.version}\n`
  output += `state_path=${summary.statePath}\n`
  if (process.env.GITHUB_OUTPUT) {
    await Bun.write(process.env.GITHUB_OUTPUT, output)
  }
} finally {
  await restoreFiles(snapshot)
}
