#!/usr/bin/env bun

import path from "node:path"
import { SYNERGY_DIST_DIR } from "./shared/packages"
import { prepareRuntimeAssets } from "./shared/runtime-assets"

export function desktopRuntimePackageNames(targets: string) {
  const names = targets
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean)
    .map((target) => `synergy-${target.replace(/^win32-/, "windows-")}`)
  if (names.length === 0) {
    throw new Error("prepare-desktop-runtime requires SYNERGY_BUILD_TARGETS")
  }
  return names
}

export async function prepareDesktopRuntimes(targets: string) {
  const names = desktopRuntimePackageNames(targets)
  for (const name of names) {
    await prepareRuntimeAssets(name)
    const runtimeDir = path.join(SYNERGY_DIST_DIR, name)
    console.log(`prepared Desktop runtime ${runtimeDir}`)
  }
  return names
}

if (import.meta.main) {
  await prepareDesktopRuntimes(process.env.SYNERGY_BUILD_TARGETS ?? "")
}
