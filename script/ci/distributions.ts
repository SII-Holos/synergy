import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileHash, filesIn, mapFiles } from "./artifacts"
import { hash } from "./plan"
import type { Plan } from "./plan"

export type Profile = "core" | "full"
export function distributionPaths(profile: Profile) {
  return profile === "core"
    ? ["packages/cli/dist/synergy-linux-x64", ".artifacts/ci/core-packages"]
    : ["packages/presets/dist/synergy-linux-x64", "packages/presets/dist/modules-packages", "apps/web/dist"]
}

export function distributionCommands(profile: Profile, root: string) {
  return [
    {
      name: profile + "-build",
      args: [
        process.execPath,
        `packages/${profile === "core" ? "cli" : "presets"}/script/build.ts`,
        "--single",
        "--skip-install",
      ],
    },
    ...(profile === "core"
      ? [
          {
            name: "core-pack",
            args: [
              process.execPath,
              "script/pack-workspace.ts",
              "packages/cli",
              path.join(root, ".artifacts/ci/core-packages"),
            ],
          },
        ]
      : []),
  ]
}

function identity(plan: Plan, profile: Profile) {
  return {
    plan: plan.digest,
    sha: plan.sha,
    run: plan.run,
    attempt: plan.attempt,
    profile,
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    abi:
      process.platform === "linux"
        ? execFileSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" }).trim()
        : process.platform,
  }
}

interface Manifest {
  identity: ReturnType<typeof identity>
  buildInput: string
  files: Array<{ path: string; sha256: string; mode: number }>
}

export async function distributionBuildIdentity(root: string, plan: Plan, profile: Profile) {
  const { sha, platform, arch, bun, abi } = identity(plan, profile)
  return hash({
    version: 1,
    sha,
    profile,
    platform,
    arch,
    bun,
    abi,
    base: await fileHash(path.join(root, ".artifacts/ci/build/manifest.json")),
    target: "linux-x64",
    sandbox: true,
    webManifest: true,
  })
}

export async function publishDistribution(root: string, plan: Plan, profile: Profile) {
  const directory = path.join(root, ".artifacts/ci/distributions", profile)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const files: Manifest["files"] = []
  for (const prefix of distributionPaths(profile)) {
    const sources = await filesIn(path.join(root, prefix))
    if (!sources.length) throw new Error(`Missing ${profile} distribution: ${prefix}`)
    files.push(
      ...(await mapFiles(sources, async (file) => {
        const relative = path.relative(root, file).split(path.sep).join("/")
        const entry = { path: relative, sha256: await fileHash(file), mode: (await stat(file)).mode & 0o777 }
        await mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
        await cp(file, path.join(directory, relative))
        return entry
      })),
    )
  }
  await Bun.write(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      identity: identity(plan, profile),
      buildInput: await distributionBuildIdentity(root, plan, profile),
      files,
    } satisfies Manifest),
  )
}

async function validateDistribution(root: string, plan: Plan, profile: Profile, cached = false) {
  const directory = path.join(root, ".artifacts/ci/distributions", profile)
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest
  if (cached) {
    const expected = identity(plan, profile)
    if (
      manifest.buildInput !== (await distributionBuildIdentity(root, plan, profile)) ||
      (["sha", "profile", "platform", "arch", "bun", "abi"] as const).some(
        (key) => manifest.identity[key] !== expected[key],
      )
    )
      throw new Error("Cached distribution inputs changed")
  }
  if (!cached && JSON.stringify(manifest.identity) !== JSON.stringify(identity(plan, profile)))
    throw new Error("Foreign distribution identity")
  const inventory = (await filesIn(directory))
    .map((file) => path.relative(directory, file).split(path.sep).join("/"))
    .filter((file) => file !== "manifest.json")
    .sort()
  const declared = manifest.files.map((file) => file.path)
  if (new Set(declared).size !== declared.length || declared.toSorted().join("\0") !== inventory.join("\0"))
    throw new Error("Distribution inventory changed")
  const prefixes = distributionPaths(profile)
  for (const prefix of prefixes)
    if (!declared.some((file) => file.startsWith(prefix + "/"))) throw new Error("Incomplete distribution")
  await mapFiles(manifest.files, async (entry) => {
    if (!prefixes.some((prefix) => entry.path.startsWith(prefix + "/")) || entry.path.split("/").includes(".."))
      throw new Error("Unowned distribution path")
    const file = path.join(directory, entry.path)
    if ((await fileHash(file)) !== entry.sha256 || ((await stat(file)).mode & 0o777) !== entry.mode)
      throw new Error(`Distribution bytes or permissions changed: ${entry.path}`)
  })
  return manifest
}

export async function rebindDistribution(root: string, plan: Plan, profile: Profile) {
  const manifest = await validateDistribution(root, plan, profile, true)
  await Bun.write(
    path.join(root, ".artifacts/ci/distributions", profile, "manifest.json"),
    JSON.stringify({ ...manifest, identity: identity(plan, profile) }),
  )
}

export async function restoreDistribution(root: string, plan: Plan, profile: Profile) {
  const directory = path.join(root, ".artifacts/ci/distributions", profile)
  const manifest = await validateDistribution(root, plan, profile)
  const prefixes = distributionPaths(profile)
  for (const prefix of prefixes) await rm(path.join(root, prefix), { recursive: true, force: true })
  await mapFiles(manifest.files, async (entry) => {
    const destination = path.join(root, entry.path)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(directory, entry.path), destination)
  })
}
