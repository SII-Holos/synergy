#!/usr/bin/env bun

import { $ } from "bun"
import { readFileSync } from "fs"
import { access, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import {
  PRODUCT_RUNTIME_DIST_DIR,
  PRODUCT_RUNTIME_DIR,
  CLI_DIR,
  SDK_DIR,
  RELEASE_CATALOG,
  REPO_ROOT,
} from "./release/shared/packages"
import {
  createPublishablePackageJson,
  readCatalog,
  type DependencyVersionMap,
  type PackageJson,
} from "./release/shared/package-manifest"
import { currentGitRemoteUrl } from "./release/shared/git"
import { stageSynergyWrapper } from "./release/nodes/prepare-synergy-packages"

const dependencyVersions = Object.fromEntries(
  Object.values(RELEASE_CATALOG).map((entry) => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, entry.directory, "package.json"), "utf8"))
    return [manifest.name, manifest.version]
  }),
)

const publishablePackages: PublishablePackage[] = Object.entries(RELEASE_CATALOG).flatMap(([id, entry]) => {
  if (!entry.registry || id === "productRuntime") return []
  return [
    {
      name: entry.registry,
      dir: path.join(REPO_ROOT, entry.directory),
      build: true,
      attw: id !== "linkProtocol",
      dependencyVersions,
    },
  ]
})

type PublishablePackage = {
  name: string
  dir: string
  build: boolean
  attw: boolean
  dependencyVersions?: DependencyVersionMap
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "synergy-package-check-"))
  try {
    for (const pkg of publishablePackages) {
      await validateWorkspacePackage(pkg, tempDir)
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

async function validateWorkspacePackage(pkg: PublishablePackage, tempDir: string) {
  console.log(`\n=== package check: ${pkg.name} ===\n`)
  if (pkg.build) {
    if (pkg.dir === SDK_DIR) await $`bun run build --compile-only`.cwd(pkg.dir)
    else await $`bun run build`.cwd(pkg.dir)
  }

  const originalText = await Bun.file(path.join(pkg.dir, "package.json")).text()
  const sourcePackageJson = JSON.parse(originalText) as PackageJson
  const publishablePackageJson = createPublishablePackageJson({
    packageJson: sourcePackageJson,
    version: String(sourcePackageJson.version),
    catalog: await readCatalog(),
    dependencyVersions: pkg.dependencyVersions,
  })

  const tarball = await stagePackablePackage({ sourceDir: pkg.dir, packageJson: publishablePackageJson, tempDir })
  await runPublint(tarball)
  if (pkg.attw) {
    await runAttw(tarball)
  }
}

async function validateSynergyWrapper(tempDir: string) {
  console.log(`\n=== package check: @ericsanchezok/synergy wrapper ===\n`)
  const version = packageVersion(PRODUCT_RUNTIME_DIR)
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
  if (!(await exists(PRODUCT_RUNTIME_DIST_DIR))) {
    console.warn("No Synergy dist directory found; validating wrapper manifest without optional platform packages.")
    return {}
  }
  const entries = await Array.fromAsync(new Bun.Glob("synergy-*/package.json").scan({ cwd: PRODUCT_RUNTIME_DIST_DIR }))
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
  await $`bun pm pack --destination ${packDir}`.cwd(dir)
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
