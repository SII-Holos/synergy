#!/usr/bin/env bun

import { $ } from "bun"
import { snapshotFiles, restoreFiles } from "./shared/files"
import { VERSION_MANAGED_PACKAGE_PATHS, NPM_REGISTRY } from "./shared/packages"
import { configureNpmAuth, npmTagMatches, npmVersionExists } from "./shared/runtime"
import type { DependencyVersionMap } from "./shared/package-manifest"
import { bunInstall } from "./nodes/bun-install"
import { generateSdk } from "./nodes/generate-sdk"
import { buildSynergyLinkProtocol } from "./nodes/build-synergy-link-protocol"
import { buildUtil } from "./nodes/build-util"
import { buildPlugin } from "./nodes/build-plugin"
import { buildPluginKit } from "./nodes/build-plugin-kit"
import { publishSdkCandidate } from "./nodes/publish-sdk-candidate"
import { publishSynergyLinkProtocolCandidate } from "./nodes/publish-synergy-link-protocol-candidate"
import { publishUtilCandidate } from "./nodes/publish-util-candidate"
import { publishPluginCandidate } from "./nodes/publish-plugin-candidate"
import { publishPluginKitCandidate } from "./nodes/publish-plugin-kit-candidate"

type PackageAlias = "sdk" | "util" | "synergy-link-protocol" | "plugin" | "plugin-kit"

const PACKAGE_BY_ALIAS: Record<PackageAlias, string> = {
  sdk: "@ericsanchezok/synergy-sdk",
  util: "@ericsanchezok/synergy-util",
  "synergy-link-protocol": "@ericsanchezok/synergy-link-protocol",
  plugin: "@ericsanchezok/synergy-plugin",
  "plugin-kit": "@ericsanchezok/synergy-plugin-kit",
}

const TAG_PREFIX_BY_ALIAS: Record<PackageAlias, string> = {
  sdk: "synergy-sdk",
  util: "synergy-util",
  "synergy-link-protocol": "synergy-link-protocol",
  plugin: "synergy-plugin",
  "plugin-kit": "synergy-plugin-kit",
}

const ALL_RELEASE_PACKAGES = Object.values(PACKAGE_BY_ALIAS)

function parsePackages(input: string | undefined): PackageAlias[] {
  const raw = (input ?? "").trim()
  if (!raw) throw new Error("SYNERGY_RELEASE_PACKAGES is required for package-only release")
  const aliases = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const result: PackageAlias[] = []
  for (const alias of aliases) {
    // Backward compat alias for existing CI pipelines — remove once CI configs are updated
    if (alias === "meta") {
      result.push("synergy-link-protocol")
      continue
    }
    if (!(alias in PACKAGE_BY_ALIAS)) {
      throw new Error(`Unknown package alias "${alias}". Use one of: ${Object.keys(PACKAGE_BY_ALIAS).join(", ")}`)
    }
    result.push(alias as PackageAlias)
  }
  return [...new Set(result)]
}

function expandPackageDependencies(aliases: PackageAlias[]): PackageAlias[] {
  const result: PackageAlias[] = []
  const add = (alias: PackageAlias) => {
    if (!result.includes(alias)) result.push(alias)
  }
  if (aliases.some((alias) => alias === "plugin" || alias === "plugin-kit")) add("util")
  for (const alias of aliases) add(alias)
  return result
}

async function latestVersion(packageName: string): Promise<string | null> {
  const response = await fetch(`${NPM_REGISTRY}/${packageName}/latest`)
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(`failed to fetch latest for ${packageName}: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as { version?: string }
  return data.version ?? null
}

function bumpVersion(version: string, bump: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((item) => Number(item) || 0)
  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

async function computeTargetVersion(packageName: string, bump: string): Promise<string> {
  const latest = await latestVersion(packageName)
  if (latest) return bumpVersion(latest, bump)

  const synergyLatest = await latestVersion("@ericsanchezok/synergy")
  if (synergyLatest) return bumpVersion(synergyLatest, bump)
  return "0.1.0"
}

async function rewriteSelectedVersions(versionByPackage: Record<string, string>) {
  for (const filePath of VERSION_MANAGED_PACKAGE_PATHS) {
    const original = await Bun.file(filePath).text()
    const pkg = JSON.parse(original) as { name?: string; version?: string }
    const version = pkg.name ? versionByPackage[pkg.name] : undefined
    if (!version) continue
    pkg.version = version
    await Bun.write(filePath, JSON.stringify(pkg, null, 2) + "\n")
    console.log(`updated version: ${filePath}`)
  }
}

async function buildPackage(alias: PackageAlias) {
  if (alias === "sdk") await generateSdk()
  if (alias === "util") await buildUtil()
  if (alias === "synergy-link-protocol") await buildSynergyLinkProtocol()
  if (alias === "plugin") await buildPlugin()
  if (alias === "plugin-kit") await buildPluginKit()
}

async function publishPackage(
  alias: PackageAlias,
  version: string,
  channel: string,
  dependencyVersions: DependencyVersionMap,
) {
  if (alias === "sdk") await publishSdkCandidate(version, channel)
  if (alias === "util") await publishUtilCandidate(version, channel)
  if (alias === "synergy-link-protocol") await publishSynergyLinkProtocolCandidate(version, channel)
  if (alias === "plugin") await publishPluginCandidate(version, channel)
  if (alias === "plugin-kit") await publishPluginKitCandidate(version, channel, dependencyVersions)
}

async function ensurePackageTag(alias: PackageAlias, version: string) {
  const tag = `${TAG_PREFIX_BY_ALIAS[alias]}-v${version}`
  const exists = await $`git rev-parse -q --verify refs/tags/${tag}`.quiet().nothrow()
  if (exists.exitCode === 0) return
  await $`git tag ${tag}`
  await $`git push --no-verify origin refs/tags/${tag}`.nothrow()
}

const bump = process.env.SYNERGY_BUMP?.trim() || "patch"
if (!["patch", "minor", "major"].includes(bump)) {
  throw new Error("package-only release requires SYNERGY_BUMP=patch|minor|major")
}
const channel = process.env.SYNERGY_NPM_TAG?.trim() || "latest"
const aliases = expandPackageDependencies(parsePackages(process.env.SYNERGY_RELEASE_PACKAGES))

const selectedVersionByPackage: Record<string, string> = {}
for (const alias of aliases) {
  selectedVersionByPackage[PACKAGE_BY_ALIAS[alias]] = await computeTargetVersion(PACKAGE_BY_ALIAS[alias], bump)
}

const dependencyVersions: DependencyVersionMap = {}
for (const packageName of ALL_RELEASE_PACKAGES) {
  dependencyVersions[packageName] =
    selectedVersionByPackage[packageName] ?? (await latestVersion(packageName)) ?? "0.1.0"
}

const snapshot = await snapshotFiles(VERSION_MANAGED_PACKAGE_PATHS)

try {
  await rewriteSelectedVersions(selectedVersionByPackage)
  await configureNpmAuth()
  await bunInstall()

  for (const alias of aliases) {
    await buildPackage(alias)
  }

  for (const alias of aliases) {
    const packageName = PACKAGE_BY_ALIAS[alias]
    const version = selectedVersionByPackage[packageName]!
    await publishPackage(alias, version, channel, dependencyVersions)
    if (!(await npmVersionExists(packageName, version))) {
      throw new Error(`missing registry version: ${packageName}@${version}`)
    }
    if (!(await npmTagMatches(packageName, channel, version))) {
      throw new Error(`expected ${packageName}@${version} to be tagged ${channel}`)
    }
    await ensurePackageTag(alias, version)
  }

  console.log(
    "package-only release",
    JSON.stringify(
      aliases.map((alias) => ({
        alias,
        package: PACKAGE_BY_ALIAS[alias],
        version: selectedVersionByPackage[PACKAGE_BY_ALIAS[alias]],
        channel,
      })),
      null,
      2,
    ),
  )
} finally {
  await restoreFiles(snapshot)
}
