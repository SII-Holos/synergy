#!/usr/bin/env bun

import { $ } from "bun"
import { readFileSync } from "fs"
import { access, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import {
  META_PROTOCOL_DIR,
  PLUGIN_DIR,
  PLUGIN_KIT_DIR,
  SDK_DIR,
  SYNERGY_DIST_DIR,
  SYNERGY_DIR,
  UTIL_DIR,
} from "./release/shared/packages"
import {
  createPublishablePackageJson,
  createSynergyWrapperPackageJson,
  readCatalog,
  type DependencyVersionMap,
  type PackageJson,
} from "./release/shared/package-manifest"
import { currentGitRemoteUrl } from "./release/shared/git"

const publishablePackages: PublishablePackage[] = [
  { name: "@ericsanchezok/synergy-sdk", dir: SDK_DIR, build: true, attw: true },
  { name: "@ericsanchezok/synergy-util", dir: UTIL_DIR, build: true, attw: true },
  { name: "@ericsanchezok/meta-protocol", dir: META_PROTOCOL_DIR, build: true, attw: true },
  {
    name: "@ericsanchezok/synergy-plugin",
    dir: PLUGIN_DIR,
    build: true,
    attw: true,
    dependencyVersions: {
      "@ericsanchezok/synergy-sdk": packageVersion(SDK_DIR),
      "@ericsanchezok/synergy-util": packageVersion(UTIL_DIR),
    },
  },
  {
    name: "@ericsanchezok/synergy-plugin-kit",
    dir: PLUGIN_KIT_DIR,
    build: true,
    attw: true,
    dependencyVersions: {
      "@ericsanchezok/synergy-plugin": packageVersion(PLUGIN_DIR),
      "@ericsanchezok/synergy-util": packageVersion(UTIL_DIR),
    },
  },
]

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

async function validateWorkspacePackage(pkg: PublishablePackage, tempDir: string) {
  console.log(`\n=== package check: ${pkg.name} ===\n`)
  const sdkOpenApiPath = path.join(SDK_DIR, "openapi.json")
  const sdkOpenApiBefore =
    pkg.dir === SDK_DIR && (await exists(sdkOpenApiPath)) ? await Bun.file(sdkOpenApiPath).text() : null
  try {
    if (pkg.build) {
      await $`bun run build`.cwd(pkg.dir)
    }
  } finally {
    if (sdkOpenApiBefore !== null) {
      await Bun.write(sdkOpenApiPath, sdkOpenApiBefore)
    }
  }

  const packageJsonPath = path.join(pkg.dir, "package.json")
  const originalText = await Bun.file(packageJsonPath).text()
  const sourcePackageJson = JSON.parse(originalText) as PackageJson
  const publishablePackageJson = createPublishablePackageJson({
    packageJson: sourcePackageJson,
    version: String(sourcePackageJson.version),
    catalog: await readCatalog(),
    dependencyVersions: pkg.dependencyVersions,
  })

  await Bun.write(packageJsonPath, JSON.stringify(publishablePackageJson, null, 2))
  try {
    const tarball = await pack(pkg.dir, tempDir)
    await runPublint(tarball)
    if (pkg.attw) {
      await runAttw(tarball)
    }
  } finally {
    await Bun.write(packageJsonPath, originalText)
  }
}

async function validateSynergyWrapper(tempDir: string) {
  console.log(`\n=== package check: @ericsanchezok/synergy wrapper ===\n`)
  const wrapperDir = path.join(tempDir, "synergy-wrapper")
  await $`mkdir -p ${path.join(wrapperDir, "bin")}`
  await $`cp ${path.join(SYNERGY_DIR, "bin", "synergy")} ${path.join(wrapperDir, "bin", "synergy")}`
  await $`cp ${path.join(SYNERGY_DIR, "script", "postinstall.mjs")} ${path.join(wrapperDir, "postinstall.mjs")}`

  const version = packageVersion(SYNERGY_DIR)
  const platformVersions = await availableSynergyPlatformVersions(version)
  const repositoryUrl = await currentGitRemoteUrl()
  await Bun.write(
    path.join(wrapperDir, "package.json"),
    JSON.stringify(
      createSynergyWrapperPackageJson({
        version,
        binName: "synergy",
        optionalDependencies: platformVersions,
        repositoryUrl,
      }),
      null,
      2,
    ),
  )

  const tarball = await pack(wrapperDir, tempDir)
  await runPublint(tarball)
}

async function availableSynergyPlatformVersions(version: string) {
  if (!(await exists(SYNERGY_DIST_DIR))) {
    console.warn("No Synergy dist directory found; validating wrapper manifest without optional platform packages.")
    return {}
  }
  const entries = await Array.fromAsync(new Bun.Glob("synergy-*/package.json").scan({ cwd: SYNERGY_DIST_DIR }))
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
  return path.join(packDir, tarballs[0])
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

await main()
