import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileHash, filesIn } from "./artifacts"
import type { Plan } from "./plan"

export type Profile = "core" | "full"
export function distributionPaths(profile: Profile) {
  return profile === "core"
    ? ["packages/cli/dist/synergy-linux-x64", ".artifacts/ci/core-packages"]
    : ["packages/presets/dist/synergy-linux-x64", "packages/presets/dist/modules-packages"]
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
  files: Array<{ path: string; sha256: string; mode: number }>
}

export async function publishDistribution(root: string, plan: Plan, profile: Profile) {
  const directory = path.join(root, ".artifacts/ci/distributions", profile)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const files: Manifest["files"] = []
  for (const prefix of distributionPaths(profile)) {
    const sources = await filesIn(path.join(root, prefix))
    if (!sources.length) throw new Error(`Missing ${profile} distribution: ${prefix}`)
    for (const file of sources) {
      const relative = path.relative(root, file).split(path.sep).join("/")
      files.push({ path: relative, sha256: await fileHash(file), mode: (await stat(file)).mode & 0o777 })
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
      await cp(file, path.join(directory, relative))
    }
  }
  await Bun.write(
    path.join(directory, "manifest.json"),
    JSON.stringify({ identity: identity(plan, profile), files } satisfies Manifest),
  )
}

export async function restoreDistribution(root: string, plan: Plan, profile: Profile) {
  const directory = path.join(root, ".artifacts/ci/distributions", profile)
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest
  if (JSON.stringify(manifest.identity) !== JSON.stringify(identity(plan, profile)))
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
  for (const entry of manifest.files) {
    if (!prefixes.some((prefix) => entry.path.startsWith(prefix + "/")) || entry.path.split("/").includes(".."))
      throw new Error("Unowned distribution path")
    const file = path.join(directory, entry.path)
    if ((await fileHash(file)) !== entry.sha256 || ((await stat(file)).mode & 0o777) !== entry.mode)
      throw new Error("Distribution bytes or permissions changed")
  }
  for (const prefix of prefixes) await rm(path.join(root, prefix), { recursive: true, force: true })
  for (const entry of manifest.files) {
    const destination = path.join(root, entry.path)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(directory, entry.path), destination)
  }
}
