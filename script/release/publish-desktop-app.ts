#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { DESKTOP_RELEASE_PLATFORMS } from "../../apps/desktop/src/release-assets"
import { sha256File } from "../../packages/plugin-host/src/installation/files"
import { currentRepo } from "../shared/current-repo"
import { createDesktopAppPackage } from "./shared/desktop-app-package"
import { publishDirectory } from "./shared/publish-generic"
import { configureNpmAuth } from "./shared/runtime"

export async function publishDesktopApplication(directory: string, version: string, repository: string) {
  const receipts = await Promise.all(
    DESKTOP_RELEASE_PLATFORMS.map((platform) =>
      Bun.file(path.join(directory, `synergy-desktop-app-${platform}.json`)).json(),
    ),
  )
  const manifest = createDesktopAppPackage({ version, repository, receipts })
  if (manifest.synergy.kind !== "app") throw new Error("Expected a Desktop application manifest")
  for (const artifact of manifest.synergy.artifacts) {
    const file = path.join(directory, path.basename(new URL(artifact.url).pathname))
    if ((await sha256File(file)) !== artifact.sha256)
      throw new Error(`Desktop artifact changed after signature validation: ${artifact.target}`)
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-package-"))
  try {
    await Bun.write(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2))
    await publishDirectory({ dir: stage, name: manifest.name, version, channel: "next" })
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const version = process.env.SYNERGY_VERSION?.trim()
  if (!version) throw new Error("Desktop application publication requires SYNERGY_VERSION")
  await configureNpmAuth()
  await publishDesktopApplication(path.resolve(process.argv[2] ?? "desktop-release"), version, await currentRepo())
}
