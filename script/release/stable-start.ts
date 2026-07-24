#!/usr/bin/env bun

import { createReleaseState, summarizeState } from "./shared/context"
import { snapshotFiles, restoreFiles } from "./shared/files"
import { VERSION_MANAGED_PACKAGE_PATHS, SYNERGY_DIST_DIR, SYNERGY_LINK_DIST_DIR } from "./shared/packages"
import { computeStableVersion, configureNpmAuth, saveReleaseState } from "./shared/runtime"
import { rewriteVersions } from "./shared/versions"
import { bunInstall } from "./nodes/bun-install"
import { buildApp } from "./nodes/build-app"
import { buildDesktop } from "./nodes/build-desktop"
import { generateSchema } from "./nodes/generate-schema"
import { generateSdk } from "./nodes/generate-sdk"
import { buildSynergyLinkProtocol } from "./nodes/build-synergy-link-protocol"
import { buildUtil } from "./nodes/build-util"
import { buildPlugin } from "./nodes/build-plugin"
import { buildPluginKit } from "./nodes/build-plugin-kit"
import { buildTui } from "./nodes/build-tui"
import { buildSynergyBinaries } from "./nodes/build-synergy-binaries"
import { buildSynergyLinkBinaries } from "./nodes/build-synergy-link-binaries"
import { prepareSynergyPackages } from "./nodes/prepare-synergy-packages"
import { validateLocalArtifacts } from "./nodes/validate-local-artifacts"
import { validateSynergyLinkArtifacts } from "./nodes/validate-synergy-link-artifacts"
import { publishSdkCandidate } from "./nodes/publish-sdk-candidate"
import { publishSynergyLinkProtocolCandidate } from "./nodes/publish-synergy-link-protocol-candidate"
import { publishUtilCandidate } from "./nodes/publish-util-candidate"
import { publishPluginCandidate } from "./nodes/publish-plugin-candidate"
import { publishPluginKitCandidate } from "./nodes/publish-plugin-kit-candidate"
import { publishTuiCandidate } from "./nodes/publish-tui-candidate"
import { publishSynergyCandidate } from "./nodes/publish-synergy-candidate"
// synergy-link npm publish removed — package too large for npm registry
// import { publishSynergyLinkCandidate } from "./nodes/publish-synergy-link-candidate"
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
  await Promise.all([generateSchema(), generateSdk(), buildSynergyLinkProtocol(), buildUtil()])
  await buildPlugin()
  await buildPluginKit()
  await buildTui()
  await buildApp()
  await buildDesktop()
  const platformNames = await buildSynergyBinaries(version, state.channel)
  const synergyLinkPlatformNames = await buildSynergyLinkBinaries(version)
  const platformPackages = await prepareSynergyPackages(version, platformNames)
  await validateLocalArtifacts(platformNames)
  await validateSynergyLinkArtifacts(synergyLinkPlatformNames)

  await publishSdkCandidate(version, state.channel)
  await publishSynergyLinkProtocolCandidate(version, state.channel)
  await publishUtilCandidate(version, state.channel)
  await publishPluginCandidate(version, state.channel)
  await publishPluginKitCandidate(version, state.channel)
  await publishTuiCandidate(version, state.channel)
  const synergy = await publishSynergyCandidate(version, state.channel)
  // synergy-link npm publish removed — package too large for npm registry (>512MB tgz)
  // await publishSynergyLinkCandidate(version, state.channel)

  state.registryPackages.push(...platformPackages)
  const synergyAssets = await packageBinaryAssets(SYNERGY_DIST_DIR, synergy.platformNames)
  const synergyLinkAssets = await packageBinaryAssets(SYNERGY_LINK_DIST_DIR, synergyLinkPlatformNames)
  state.binaryAssets = [...synergyAssets, ...synergyLinkAssets]
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
