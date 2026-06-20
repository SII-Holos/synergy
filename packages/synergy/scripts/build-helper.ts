#!/usr/bin/env bun
import * as fs from "fs"
import * as path from "path"
import { createHash } from "crypto"
import { $ } from "bun"

const platform = process.argv[2] ?? "linux"
const helperDir = platform === "linux" ? "helper-linux" : "helper"
const targetModule = platform === "linux" ? "linux.ts" : "windows.ts"
const constName = platform === "linux" ? "TRUSTED_LINUX_HELPER_HASHES" : "TRUSTED_HELPER_HASHES"
const binaryName = platform === "linux" ? "synergy-sandbox-linux" : "synergy-sandbox-windows.exe"

const helperDirAbs = path.resolve(import.meta.dir, "..", "src", "sandbox", helperDir)
const binaryPath = path.join(helperDirAbs, "target/release", binaryName)

// Build
console.log(`Building ${platform} helper in ${helperDirAbs}...`)
await $`cargo build --release`.cwd(helperDirAbs)

// Compute hash
const binary = fs.readFileSync(binaryPath)
const hash = createHash("sha256").update(binary).digest("hex")

console.log(`platform: ${platform}`)
console.log(`binary: ${binaryName}`)
console.log(`SHA-256: ${hash}`)
console.log()
console.log(`Add to packages/synergy/src/sandbox/${targetModule}:`)
console.log(`export const ${constName}: Record<string, string> = {`)
console.log(`  path.join(homedir, ".synergy", "sandbox-helper", "${binaryName}"): "${hash}",`)
console.log(`}`)
