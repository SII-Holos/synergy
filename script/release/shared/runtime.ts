import { $ } from "bun"
import path from "path"
import { currentRepo } from "../../shared/current-repo"
import {
  FIXED_REGISTRY_PACKAGES,
  NPM_REGISTRY,
  RELEASE_STATE_DIR,
  RELEASE_TAG_PREFIX,
  type ReleaseKind,
  type ReleaseState,
  REPO_ROOT,
} from "./packages"

const rootPkgPath = path.join(REPO_ROOT, "package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

if (process.versions.bun !== expectedBunVersion) {
  throw new Error(`This script requires bun@${expectedBunVersion}, but you are using bun@${process.versions.bun}`)
}

export function releaseStatePath(kind: ReleaseKind, version: string) {
  return path.join(RELEASE_STATE_DIR, `${kind}-${version}.json`)
}

export async function ensureReleaseStateDir() {
  await Bun.$`mkdir -p ${RELEASE_STATE_DIR}`
}

export async function loadReleaseState(kind: ReleaseKind, version: string): Promise<ReleaseState> {
  const filepath = releaseStatePath(kind, version)
  return await Bun.file(filepath).json()
}

export async function saveReleaseState(state: ReleaseState) {
  await ensureReleaseStateDir()
  await Bun.write(releaseStatePath(state.kind, state.version), JSON.stringify(state, null, 2) + "\n")
}

export function releaseTag(version: string) {
  return `${RELEASE_TAG_PREFIX}${version}`
}

export function releaseEnv() {
  return { GH_TOKEN: process.env.SYNERGY_RELEASE_TOKEN || process.env.GITHUB_TOKEN || process.env.RELEASE_TOKEN || "" }
}

export function npmAuthArgs() {
  return process.env.NPM_TOKEN ? [`--//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`] : []
}

export async function configureNpmAuth() {
  if (!process.env.NPM_TOKEN) {
    console.log("WARNING: NPM_TOKEN not found in environment")
    return
  }
  const npmrc = path.join(process.env.HOME || process.env.USERPROFILE || REPO_ROOT, ".npmrc")
  await Bun.write(npmrc, `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`)
}

export async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delay = 10_000 }: { attempts?: number; delay?: number } = {},
): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === attempts) throw error
      console.log(`attempt ${i}/${attempts} failed, retrying in ${delay / 1000}s...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error("unreachable")
}

export async function npmVersionExists(name: string, version: string) {
  const response = await fetch(`${NPM_REGISTRY}/${name}/${version}`)
  return response.ok
}

export async function waitForNpmVersion(
  name: string,
  version: string,
  { attempts = 12, delay = 5_000 }: { attempts?: number; delay?: number } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await npmVersionExists(name, version)) {
      return true
    }
    if (attempt < attempts) {
      console.log(`waiting for ${name}@${version} to appear in npm registry (${attempt}/${attempts})`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  return false
}

export async function npmDistTagList(name: string): Promise<Record<string, string>> {
  const response = await fetch(`${NPM_REGISTRY}/-/package/${name}/dist-tags`)
  if (!response.ok) {
    throw new Error(`failed to fetch dist-tags for ${name}: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as Record<string, string>
}

export async function npmTagMatches(name: string, tag: string, version: string) {
  const tags = await npmDistTagList(name)
  return tags[tag] === version
}

export async function npmEnsureDistTag(name: string, version: string, tag: string) {
  if (await npmTagMatches(name, tag, version)) {
    return false
  }
  await retry(() => $`npm dist-tag add ${`${name}@${version}`} ${tag}`)
  return true
}

export async function npmPromoteToLatest(name: string, version: string) {
  await retry(() => $`npm dist-tag add ${`${name}@${version}`} latest`)
}

export async function computeStableVersion(bump: string) {
  const response = await fetch(`${NPM_REGISTRY}/${FIXED_REGISTRY_PACKAGES[3]}/latest`)
  if (!response.ok) {
    throw new Error(`failed to fetch latest stable version: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as { version?: string }
  const version = data.version ?? "0.1.0"
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((item) => Number(item) || 0)
  const normalized = bump.toLowerCase()
  if (normalized === "major") return `${major + 1}.0.0`
  if (normalized === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function computeDevVersion(channel: string) {
  return `0.0.0-${channel}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
}

export async function getLatestReleaseVersion() {
  const repo = await currentRepo()
  const result = await $`gh api /repos/${repo}/releases/latest --jq '.tag_name'`.env(releaseEnv()).nothrow().quiet()
  if (result.exitCode !== 0) return null
  const tag = result.text().trim()
  return tag ? tag.replace(/^v/, "") : null
}
