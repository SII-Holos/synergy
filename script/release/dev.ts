#!/usr/bin/env bun

import { parseArgs } from "util"
import { createReleaseState, summarizeState } from "./shared/context"
import { snapshotFiles, restoreFiles } from "./shared/files"
import { VERSION_MANAGED_PACKAGE_PATHS } from "./shared/packages"
import { computeDevVersion, configureNpmAuth } from "./shared/runtime"
import { rewriteVersions } from "./shared/versions"
import { bunInstall } from "./nodes/bun-install"
import { buildApp } from "./nodes/build-app"
import { buildConfigUI } from "./nodes/build-config-ui"
import { generateSchema } from "./nodes/generate-schema"
import { generateSdk } from "./nodes/generate-sdk"
import { buildMetaProtocol } from "./nodes/build-meta-protocol"
import { buildPlugin } from "./nodes/build-plugin"
import { buildSynergyBinaries } from "./nodes/build-synergy-binaries"
import { prepareSynergyPackages } from "./nodes/prepare-synergy-packages"
import { validateLocalArtifacts } from "./nodes/validate-local-artifacts"
import { publishSdkCandidate } from "./nodes/publish-sdk-candidate"
import { publishMetaProtocolCandidate } from "./nodes/publish-meta-protocol-candidate"
import { publishPluginCandidate } from "./nodes/publish-plugin-candidate"
import { publishSynergyCandidate } from "./nodes/publish-synergy-candidate"
import { publishMetaSynergyCandidate } from "./nodes/publish-meta-synergy-candidate"

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
  await Promise.all([generateSchema(), generateSdk(), buildMetaProtocol()])
  await buildPlugin()
  await Promise.all([buildApp(), buildConfigUI()])
  const platformNames = await buildSynergyBinaries(version, channel)
  await prepareSynergyPackages(version, platformNames)
  await validateLocalArtifacts(platformNames)
  await publishSdkCandidate(version, channel)
  await publishMetaProtocolCandidate(version, channel)
  await publishPluginCandidate(version, channel)
  const synergy = await publishSynergyCandidate(version, channel)
  await publishMetaSynergyCandidate(version, channel)
  state.registryPackages.push(...synergy.platformPackages, "@ericsanchezok/meta-synergy")
  console.log("dev release", JSON.stringify(summarizeState(state), null, 2))
} finally {
  await restoreFiles(snapshot)
}
