import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { assertRuntimeManifest } from "../shared/runtime-contract"

export async function packageBinaryAssets(distDir: string, platformNames: string[]) {
  console.log("\n=== package binary assets ===\n")
  const assetPaths: string[] = []
  for (const name of platformNames) {
    const cwd = path.join(distDir, name)
    if (isSynergyRuntime(name)) await assertRuntimeManifest(cwd, name)
    const assetName = name.includes("linux") ? `${name}.tar.gz` : `${name}.zip`
    const assetPath = path.join(distDir, assetName)
    await fs.rm(assetPath, { force: true })
    if (name.includes("linux")) {
      await $`tar -czf ${assetPath} *`.cwd(cwd)
    } else {
      await $`zip -r ${assetPath} *`.cwd(cwd).quiet()
    }
    if (isSynergyRuntime(name)) await validatePackagedRuntimeArchive(assetPath, name)
    assetPaths.push(assetPath)
  }
  return assetPaths
}

export async function validatePackagedRuntimeArchive(assetPath: string, name: string): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-release-archive-"))
  try {
    await assertArchiveMembersSafe(assetPath)
    if (assetPath.endsWith(".tar.gz")) {
      await $`tar -xzf ${assetPath} -C ${directory}`
    } else if (assetPath.endsWith(".zip")) {
      await $`unzip -q ${assetPath} -d ${directory}`
    } else {
      throw new Error(`unsupported release archive: ${assetPath}`)
    }
    await assertRuntimeManifest(directory, name)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

export async function assertArchiveMembersSafe(assetPath: string): Promise<void> {
  if (assetPath.endsWith(".tar.gz")) {
    const verbose = await $`tar -tvzf ${assetPath}`.text()
    if (verbose.split("\n").some((line) => line.startsWith("l") || line.startsWith("h"))) {
      throw new Error("release archive contains a symbolic or hard link")
    }
    assertArchiveMemberNamesSafe(await $`tar -tzf ${assetPath}`.text())
    return
  }
  if (assetPath.endsWith(".zip")) {
    const verbose = await $`unzip -Z -l ${assetPath}`.text()
    if (verbose.split("\n").some((line) => line.startsWith("l"))) {
      throw new Error("release archive contains a symbolic link")
    }
    assertArchiveMemberNamesSafe(await $`unzip -Z1 ${assetPath}`.text())
    return
  }
  throw new Error(`unsupported release archive: ${assetPath}`)
}

export function assertArchiveMemberNamesSafe(listing: string): void {
  for (const member of listing.split("\n")) {
    if (!member) continue
    if (
      member.startsWith("/") ||
      member.startsWith("\\") ||
      /^[A-Za-z]:/.test(member) ||
      member.includes("\\") ||
      member.split("/").includes("..")
    ) {
      throw new Error(`release archive contains an unsafe path: ${member}`)
    }
  }
}

export async function createBinaryChecksums(version: string, assetPaths: string[], outputDir: string): Promise<string> {
  const checksumPath = path.join(outputDir, `Synergy-${version}-cli-checksums.txt`)
  const lines: string[] = []
  for (const assetPath of [...assetPaths].sort()) {
    const data = await fs.readFile(assetPath)
    lines.push(`${createHash("sha256").update(data).digest("hex")}  ${path.basename(assetPath)}`)
  }
  await fs.writeFile(checksumPath, `${lines.join("\n")}\n`)
  return checksumPath
}

function isSynergyRuntime(name: string): boolean {
  return /^synergy-(linux|darwin|windows)-(?:x64|arm64)(?:-|$)/.test(name)
}
