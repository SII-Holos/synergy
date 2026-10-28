#!/usr/bin/env bun
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppArtifact } from "../../packages/plugin/src/package"
import {
  extractApplicationZip,
  verifyApplicationSignature,
} from "../../packages/plugin-host/src/installation/applications"
import { sha256File } from "../../packages/plugin-host/src/installation/files"
import { DESKTOP_RELEASE_DIR } from "./shared/packages"
import {
  DESKTOP_UPGRADE_RECEIPT,
  DesktopUpgradeReceipt,
  desktopApplicationArtifacts,
} from "./shared/desktop-app-package"
import releasedUpgrade from "./released-upgrade-artifacts.json"
import { verifyReleasedUpgrade } from "./verify-released-upgrade"

export async function verifyDesktopUpgrade(
  options: { directory: string; version: string; teamID: string; junit?: string },
  context: {
    signature?: typeof verifyApplicationSignature
    upgrade?: typeof verifyReleasedUpgrade
  } = {},
) {
  const output = path.join(options.directory, DESKTOP_UPGRADE_RECEIPT)
  await rm(output, { force: true })
  if (options.junit) await rm(path.resolve(options.junit), { force: true })
  const { file, artifact } = desktopApplicationArtifacts(options.version, "darwin").find(
    (item) => item.artifact.target === "darwin-arm64",
  )!
  const archive = path.join(options.directory, file)
  const identity = AppArtifact.parse({
    ...artifact,
    url: `https://release.invalid/${file}`,
    sha256: await sha256File(archive),
    signing: { type: "apple", teamID: options.teamID },
  })
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "synergy-desktop-upgrade-")))
  const signature = context.signature ?? verifyApplicationSignature
  try {
    await extractApplicationZip(archive, directory)
    const executable = path.join(directory, identity.executable)
    const candidate = path.join(directory, "Synergy.app/Contents/Resources/synergy")
    await signature(executable, identity)
    await (context.upgrade ?? verifyReleasedUpgrade)({ candidate, version: options.version, junit: options.junit })
    await signature(executable, identity)
    if ((await sha256File(archive)) !== identity.sha256)
      throw new Error("Desktop archive changed during upgrade acceptance")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const receipt = DesktopUpgradeReceipt.parse({
    version: options.version,
    previousVersion: releasedUpgrade.version,
    target: identity.target,
    artifact: file,
    sha256: identity.sha256,
  })
  await Bun.write(output, JSON.stringify(receipt, null, 2) + "\n")
  return receipt
}

if (import.meta.main) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Final Desktop upgrade acceptance requires a macOS arm64 runner")
  const version = process.env.SYNERGY_VERSION?.trim()
  const teamID = process.env.APPLE_TEAM_ID?.trim()
  if (!version || !teamID)
    throw new Error("Final Desktop upgrade acceptance requires SYNERGY_VERSION and APPLE_TEAM_ID")
  await verifyDesktopUpgrade({
    directory: path.resolve(process.argv[2] ?? DESKTOP_RELEASE_DIR),
    version,
    teamID,
    junit: process.env.SYNERGY_UPGRADE_JUNIT,
  })
}
