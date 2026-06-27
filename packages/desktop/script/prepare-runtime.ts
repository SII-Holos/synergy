#!/usr/bin/env bun
import { $ } from "bun"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const platformName = process.platform === "win32" ? "windows" : process.platform
const runtimeName = `synergy-${platformName}-${process.arch}`
const runtimeDir = path.join(repoRoot, "packages/synergy/dist", runtimeName)

if (!fs.existsSync(path.join(runtimeDir, "bin"))) {
  await $`bun run ./packages/synergy/script/build.ts --single --skip-install`.cwd(repoRoot)
}

if (!fs.existsSync(path.join(runtimeDir, "bin"))) {
  throw new Error(`Failed to prepare Synergy runtime for desktop package: ${runtimeDir}`)
}
