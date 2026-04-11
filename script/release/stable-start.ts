#!/usr/bin/env bun

import { createReleaseState, summarizeState } from "./shared/context"
import { snapshotFiles, restoreFiles } from "./shared/files"
import { VERSION_MANAGED_PACKAGE_PATHS, SYNERGY_DIST_DIR, META_SYNERGY_DIST_DIR } from "./shared/packages"
import { computeStableVersion, configureNpmAuth, saveReleaseState } from "./shared/runtime"
import { rewriteVersions } from "./shared/versions"
import { bunInstall } from "./nodes/bun-install"
import { buildApp } from "./nodes/build-app"
import { buildConfigUI } from "./nodes/build-config-ui"
import { generateSchema } from "./nodes/generate-schema"
import { generateSdk } from "./nodes/generate-sdk"
import { buildMetaProtocol } from "./nodes/build-meta-protocol"
import { buildPlugin } from "./nodes/build-plugin"
import { buildSynergyBinaries } from "./nodes/build-synergy-binaries"
import { buildMetaSynergyBinaries } from "./nodes/build-meta-synergy-binaries"
import { prepareSynergyPackages } from "./nodes/prepare-synergy-packages"
import { validateLocalArtifacts } from "./nodes/validate-local-artifacts"
import { validateMetaSynergyArtifacts } from "./nodes/validate-meta-synergy-artifacts"
import { publishSdkCandidate } from "./nodes/publish-sdk-candidate"
import { publishMetaProtocolCandidate } from "./nodes/publish-meta-protocol-candidate"
import { publishPluginCandidate } from "./nodes/publish-plugin-candidate"
import { publishSynergyCandidate } from "./nodes/publish-synergy-candidate"
import { packageBinaryAssets } from "./nodes/package-binary-assets"
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
  await Promise.all([generateSchema(), generateSdk(), buildMetaProtocol()])
  await buildPlugin()
  await Promise.all([buildApp(), buildConfigUI()])
  const platformNames = await buildSynergyBinaries(version, state.channel)
  const metaSynergyPlatformNames = await buildMetaSynergyBinaries(version)
  const platformPackages = await prepareSynergyPackages(version, platformNames)
  await validateLocalArtifacts(platformNames)
  await validateMetaSynergyArtifacts(metaSynergyPlatformNames)

  await publishSdkCandidate(version, state.channel)
  await publishMetaProtocolCandidate(version, state.channel)
  await publishPluginCandidate(version, state.channel)
  const synergy = await publishSynergyCandidate(version, state.channel)

  state.registryPackages.push(...platformPackages)
  const synergyAssets = await packageBinaryAssets(SYNERGY_DIST_DIR, synergy.platformNames)
  const metaSynergyAssets = await packageBinaryAssets(META_SYNERGY_DIST_DIR, metaSynergyPlatformNames)
  state.binaryAssets = [...synergyAssets, ...metaSynergyAssets]
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
