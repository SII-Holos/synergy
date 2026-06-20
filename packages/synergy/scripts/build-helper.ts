#!/usr/bin/env bun
import * as fs from "fs"
import * as path from "path"
import { createHash } from "crypto"
import { $ } from "bun"

const args = process.argv.slice(2)

const platform = args.find((a) => a === "linux" || a === "windows") ?? "linux"
const helperDir = platform === "linux" ? "helper-linux" : "helper"
const targetModule = platform === "linux" ? "linux.ts" : "windows.ts"
const constName = platform === "linux" ? "TRUSTED_LINUX_HELPER_HASHES" : "TRUSTED_HELPER_HASHES"
const binaryName = platform === "linux" ? "synergy-sandbox-linux" : "synergy-sandbox-windows.exe"

const targetArgIdx = args.indexOf("--target")
const targetTriple = targetArgIdx >= 0 ? args[targetArgIdx + 1] : null
const dryRun = args.includes("--dry-run")
const skipBuild = args.includes("--skip-build")

const helperDirAbs = path.resolve(import.meta.dir, "..", "src", "sandbox", helperDir)
const releaseSubdir = targetTriple ? path.join("target", targetTriple, "release") : path.join("target", "release")
const binaryPath = path.join(helperDirAbs, releaseSubdir, binaryName)

if (dryRun) {
  console.log(`[dry-run] Would build ${platform} helper in ${helperDirAbs}`)
  if (targetTriple) {
    console.log(`[dry-run] Would use target triple: ${targetTriple}`)
  }
} else if (skipBuild) {
  console.log(`Skipping build for ${platform} (--skip-build)`)
} else {
  // Build
  console.log(`Building ${platform} helper in ${helperDirAbs}...`)
  if (targetTriple) {
    await $`cargo build --release --target ${targetTriple}`.cwd(helperDirAbs)
  } else {
    await $`cargo build --release`.cwd(helperDirAbs)
  }
}

// Compute hash (use placeholder for dry-run)
let hash: string
if (dryRun) {
  hash = "0000000000000000000000000000000000000000000000000000000000000000"
  console.log(`[dry-run] Would read binary at: ${binaryPath}`)
} else {
  const binary = fs.readFileSync(binaryPath)
  hash = createHash("sha256").update(binary).digest("hex")
}

console.log(`platform: ${platform}`)
if (targetTriple) console.log(`target: ${targetTriple}`)
console.log(`binary: ${binaryName}`)
console.log(`SHA-256: ${hash}`)
console.log()
console.log(`Add to packages/synergy/src/sandbox/${targetModule}:`)
console.log(`export const ${constName}: Record<string, string> = {`)
console.log(`  [path.join(os.homedir(), ".synergy", "sandbox-helper", "${binaryName}")]: "${hash}",`)
console.log(`}`)

const autoUpdate = args.includes("--auto-update")
const append = args.includes("--append")
if (autoUpdate) {
  const sourceFile = path.resolve(import.meta.dir, "..", "src", "sandbox", targetModule)
  let content = fs.readFileSync(sourceFile, "utf-8")

  const archSuffix = targetTriple
    ? targetTriple.includes("aarch64")
      ? "-arm64"
      : targetTriple.includes("x86_64")
        ? "-x64"
        : ""
    : ""
  const binaryKey = binaryName + archSuffix
  const newEntry = `  [path.join(os.homedir(), ".synergy", "sandbox-helper", "${binaryKey}")]: "${hash}",`

  if (append) {
    // Append mode: insert the new entry before the closing `}` of the existing map,
    // preserving all existing entries.
    const pattern = new RegExp(`(export const ${constName}: Record<string, string> = \\{[^}]*)`, "s")
    if (pattern.test(content)) {
      content = content.replace(pattern, `$1\n${newEntry}`)
    } else {
      // Map not in expected format — fall back to full replacement
      const fallbackPattern = new RegExp(`export const ${constName}: Record<string, string> = \\{[^}]*\\}`, "s")
      content = content.replace(
        fallbackPattern,
        `export const ${constName}: Record<string, string> = {\n${newEntry}\n}`,
      )
    }
  } else {
    // Replace mode: replace the entire map.
    if (dryRun) {
      const replacement = `export const ${constName}: Record<string, string> = {\n${newEntry}\n}`
      console.log(`[dry-run] Would update ${sourceFile} with:`)
      console.log(replacement)
    } else {
      const pattern = new RegExp(`export const ${constName}: Record<string, string> = \\{[^}]*\\}`, "s")
      content = content.replace(pattern, `export const ${constName}: Record<string, string> = {\n${newEntry}\n}`)
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Would update ${sourceFile}`)
  } else {
    fs.writeFileSync(sourceFile, content)
    console.log(`Updated ${sourceFile}`)
  }
}
