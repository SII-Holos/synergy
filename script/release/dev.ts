#!/usr/bin/env bun

import { parseArgs } from "util"
import { createReleaseState, summarizeState } from "./shared/context"
import { snapshotFiles, restoreFiles } from "./shared/files"
import { VERSION_MANAGED_PACKAGE_PATHS } from "./shared/packages"
import { computeDevVersion, configureNpmAuth } from "./shared/runtime"
import { rewriteVersions } from "./shared/versions"
import { bunInstall } from "./nodes/bun-install"
import { buildApp } from "./nodes/build-app"
import { generateSchema } from "./nodes/generate-schema"
import { generateSdk } from "./nodes/generate-sdk"
import { buildSynergyLinkProtocol } from "./nodes/build-synergy-link-protocol"
import { buildUtil } from "./nodes/build-util"
import { buildPlugin } from "./nodes/build-plugin"
import { buildPluginKit } from "./nodes/build-plugin-kit"
import { buildTui } from "./nodes/build-tui"
import { buildSynergyBinaries } from "./nodes/build-synergy-binaries"
import { prepareSynergyPackages } from "./nodes/prepare-synergy-packages"
import { validateLocalArtifacts } from "./nodes/validate-local-artifacts"
import { publishSdkCandidate } from "./nodes/publish-sdk-candidate"
import { publishSynergyLinkProtocolCandidate } from "./nodes/publish-synergy-link-protocol-candidate"
import { publishUtilCandidate } from "./nodes/publish-util-candidate"
import { publishPluginCandidate } from "./nodes/publish-plugin-candidate"
import { publishPluginKitCandidate } from "./nodes/publish-plugin-kit-candidate"
import { publishTuiCandidate } from "./nodes/publish-tui-candidate"
import { publishSynergyCandidate } from "./nodes/publish-synergy-candidate"
// synergy-link npm publish removed — package too large for npm registry
// import { publishSynergyLinkCandidate } from "./nodes/publish-synergy-link-candidate"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    channel: { type: "string", default: "dev" },
  },
})

const channel = values.channel || "dev"
const version = process.env.SYNERGY_VERSION?.trim() || computeDevVersion(channel)
const state = createReleaseState({
  kind: "dev",
  version,
  channel,
  promoteTag: null,
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
  const platformNames = await buildSynergyBinaries(version, channel)
  await prepareSynergyPackages(version, platformNames)
  await validateLocalArtifacts(platformNames)
  await publishSdkCandidate(version, channel)
  await publishSynergyLinkProtocolCandidate(version, channel)
  await publishUtilCandidate(version, channel)
  await publishPluginCandidate(version, channel)
  await publishPluginKitCandidate(version, channel)
  await publishTuiCandidate(version, channel)
  const synergy = await publishSynergyCandidate(version, channel)
  // synergy-link npm publish removed — package too large for npm registry
  // await publishSynergyLinkCandidate(version, channel)
  state.registryPackages.push(...synergy.platformPackages)
  console.log("dev release", JSON.stringify(summarizeState(state), null, 2))
} finally {
  await restoreFiles(snapshot)
}
