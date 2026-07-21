#!/usr/bin/env bun
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const args = process.argv.slice(2)
const platform = args.find((arg) => arg === "linux" || arg === "windows") ?? "linux"
const helperDir = platform === "linux" ? "helper-linux" : "helper"
const binaryName = platform === "linux" ? "synergy-sandbox-linux" : "synergy-sandbox-windows.exe"
const targetIndex = args.indexOf("--target")
const targetTriple = targetIndex >= 0 ? args[targetIndex + 1] : undefined
const helperPathIndex = args.indexOf("--helper-path")
const helperPath = helperPathIndex >= 0 ? args[helperPathIndex + 1] : undefined
const dryRun = args.includes("--dry-run")
const skipBuild = args.includes("--skip-build")
const localMode = args.includes("--local")

if (args.includes("--auto-update") || args.includes("--append")) {
  throw new Error("Helper hashes are embedded by script/build.ts; source hash maps are no longer updated")
}
if (targetIndex >= 0 && !targetTriple) throw new Error("--target requires a Rust target triple")
if (helperPathIndex >= 0 && !helperPath) throw new Error("--helper-path requires a file path")

const helperDirectory = path.resolve(import.meta.dir, "..", "src", "sandbox", helperDir)
const releaseDirectory = targetTriple ? path.join("target", targetTriple, "release") : path.join("target", "release")
const builtBinary = path.join(helperDirectory, releaseDirectory, binaryName)
const binaryPath = helperPath ? path.resolve(process.cwd(), helperPath) : builtBinary

if (dryRun) {
  console.log(`[dry-run] Would build ${platform} helper in ${helperDirectory}`)
  if (targetTriple) console.log(`[dry-run] Would use target triple: ${targetTriple}`)
  console.log(`[dry-run] Would read binary at: ${binaryPath}`)
} else if (!skipBuild) {
  console.log(`Building ${platform} helper in ${helperDirectory}...`)
  if (targetTriple) {
    await $`cargo build --release --target ${targetTriple}`.cwd(helperDirectory)
  } else {
    await $`cargo build --release`.cwd(helperDirectory)
  }
}

const hash = dryRun
  ? "0000000000000000000000000000000000000000000000000000000000000000"
  : createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex")

console.log(`platform: ${platform}`)
if (targetTriple) console.log(`target: ${targetTriple}`)
console.log(`binary: ${binaryName}`)
console.log(`SHA-256: ${hash}`)
console.log("Runtime release builds embed this hash while packaging the matching helper asset.")

if (localMode) {
  const destinationDirectory = path.join(os.homedir(), ".synergy", "sandbox-helper")
  const destination = path.join(destinationDirectory, binaryName)
  if (dryRun) {
    console.log(`[dry-run] Would install helper at: ${destination}`)
  } else {
    fs.mkdirSync(destinationDirectory, { recursive: true })
    fs.copyFileSync(binaryPath, destination)
    if (platform === "linux") fs.chmodSync(destination, 0o755)
    console.log(`Installed ${binaryName} at ${destination}`)
  }
}
