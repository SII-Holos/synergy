#!/usr/bin/env bun

import { $ } from "bun"
import { readFileSync } from "fs"
import { access, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { PRESETS_DIST_DIR, PRESETS_DIR, CLI_DIR, RELEASE_CATALOG } from "./release/shared/packages"
import type { PackageJson } from "./release/shared/package-manifest"
import { packWorkspace, runtimePackages } from "./pack-workspace"
import { readPackedArchives } from "./package-install-check"
import { currentGitRemoteUrl } from "./release/shared/git"
import { stageSynergyWrapper } from "./release/nodes/prepare-synergy-packages"

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "synergy-package-check-"))
  try {
    const entries = Object.entries(RELEASE_CATALOG).filter(([, entry]) => entry.registry)
    const output = path.join(tempDir, "modules")
    await packWorkspace(
      entries.map(([, entry]) => entry.directory),
      output,
      { targets: [] },
    )
    const archives = await readPackedArchives(output)
    for (const [id, entry] of entries) {
      const archive = archives.find((pkg) => pkg.name === entry.registry)
      if (!archive) throw new Error(`Missing publishable package: ${entry.registry}`)
      console.log(`\n=== package check: ${archive.name} ===\n`)
      await runPublint(archive.archive)
      if (!runtimePackages.has(entry.directory) && id !== "linkProtocol") await runAttw(archive.archive)
    }
    await validateSynergyWrapper(tempDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function stagePackablePackage(options: { sourceDir: string; packageJson: PackageJson; tempDir: string }) {
  const stagedDir = await mkdtemp(path.join(options.tempDir, "stage-"))
  await $`cp -R ${options.sourceDir}/. ${stagedDir}/`
  await Bun.write(path.join(stagedDir, "package.json"), JSON.stringify(options.packageJson, null, 2))
  return pack(stagedDir, options.tempDir)
}

async function validateSynergyWrapper(tempDir: string) {
  console.log(`\n=== package check: @ericsanchezok/synergy wrapper ===\n`)
  const version = packageVersion(PRESETS_DIR)
  const wrapperDir = await stageSynergyWrapper({
    cliDir: CLI_DIR,
    runtimeDistDir: tempDir,
    version,
    optionalDependencies: await availableSynergyPlatformVersions(version),
    repositoryUrl: await currentGitRemoteUrl(),
  })

  const tarball = await pack(wrapperDir, tempDir)
  await runPublint(tarball)
}

async function availableSynergyPlatformVersions(version: string) {
  if (!(await exists(PRESETS_DIST_DIR))) {
    console.warn("No Synergy dist directory found; validating wrapper manifest without optional platform packages.")
    return {}
  }
  const entries = await Array.fromAsync(new Bun.Glob("synergy-*/package.json").scan({ cwd: PRESETS_DIST_DIR }))
  if (entries.length === 0) {
    console.warn(
      "No built Synergy platform packages found; validating wrapper manifest without optional platform packages.",
    )
    return {}
  }

  const optionalDependencies: Record<string, string> = {}
  for (const entry of entries) {
    const name = path.dirname(entry)
    optionalDependencies[`@ericsanchezok/${name}`] = version
  }
  return optionalDependencies
}

async function pack(dir: string, tempDir: string) {
  const packDir = await mkdtemp(path.join(tempDir, "pack-"))
  await $`bun pm pack --ignore-scripts --destination ${packDir}`.cwd(dir)
  const tarballs = await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: packDir }))
  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball in ${packDir}, found ${tarballs.length}`)
  }
  return path.join(packDir, tarballs[0]!)
}

async function runPublint(tarball: string) {
  await $`bunx publint run ${tarball} --strict`
}

async function runAttw(tarball: string) {
  await $`bunx attw ${tarball} --format table --profile esm-only`
}

function packageVersion(dir: string) {
  const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string }
  return packageJson.version
}

async function exists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

if (import.meta.main) await main()
