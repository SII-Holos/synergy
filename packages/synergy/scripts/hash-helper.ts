#!/usr/bin/env bun
import * as fs from "fs"
import * as path from "path"
import { createHash } from "crypto"

// Usage:
//   bun run scripts/hash-helper.ts <path-to-helper-binary> <platform>
// Platform: "linux" or "windows"

const [binPath, platform] = process.argv.slice(2)
if (!binPath || !platform) {
  console.error("Usage: scripts/hash-helper.ts <path-to-helper> <linux|windows>")
  process.exit(1)
}

const hash = createHash("sha256")
hash.update(fs.readFileSync(binPath))
const digest = hash.digest("hex")

const targetModule = platform === "linux" ? "linux.ts" : "windows.ts"
const constName = platform === "linux" ? "TRUSTED_LINUX_HELPER_HASHES" : "TRUSTED_HELPER_HASHES"

console.log(`SHA-256: ${digest}`)
console.log()
console.log(`# Update ${constName} in packages/synergy/src/sandbox/${targetModule}:`)
console.log()
const helperName = platform === "linux" ? "synergy-sandbox-linux" : "synergy-sandbox-windows.exe"
console.log(`export const ${constName}: Record<string, string> = {`)
console.log(`  path.join(homedir, ".synergy", "sandbox-helper", "${helperName}"): "${digest}",`)
console.log(`}`)

if (process.argv.includes("--generate")) {
  const sourceFile = path.resolve(import.meta.dir, "..", "src", "sandbox", targetModule)
  let content = fs.readFileSync(sourceFile, "utf-8")
  const pattern = new RegExp(`export const ${constName}: Record<string, string> = \\{[^}]*\\}`, "s")
  const replacement = `export const ${constName}: Record<string, string> = {
  path.join(homedir, ".synergy", "sandbox-helper", "${helperName}"): "${digest}",
}`
  content = content.replace(pattern, replacement)
  fs.writeFileSync(sourceFile, content)
  console.log(`Updated ${sourceFile} with new hash entry`)
}

// Also output the JSON format for potential future release automation
console.log()
console.log("# Release JSON:")
console.log(JSON.stringify({ platform, binary: binPath, sha256: digest }, null, 2))
