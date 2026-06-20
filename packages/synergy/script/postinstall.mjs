#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Load shared platform detection from platform-package.cjs (co-located in bin/)
const platformPkg = require(path.join(__dirname, "bin/platform-package.cjs"))

function findBinary() {
  const candidates = platformPkg.candidatePackageNames()
  const binaryName = platformPkg.packageBinaryName()

  for (const packageName of candidates) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`)
      const packageDir = path.dirname(packageJsonPath)
      const binaryPath = path.join(packageDir, "bin", binaryName)

      if (fs.existsSync(binaryPath)) {
        return { binaryPath, binaryName }
      }
    } catch {}
  }

  throw new Error(`Could not find a platform package for this system. Tried: ${candidates.join(", ")}`)
}

function prepareBinDirectory(binaryName) {
  const binDir = path.join(__dirname, "bin")
  const targetPath = path.join(binDir, binaryName)

  // Ensure bin directory exists
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true })
  }

  // Remove existing binary/symlink if it exists
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath)
  }

  return { binDir, targetPath }
}

function symlinkBinary(sourcePath, binaryName) {
  const { targetPath } = prepareBinDirectory(binaryName)

  fs.symlinkSync(sourcePath, targetPath)
  console.log(`synergy binary symlinked: ${targetPath} -> ${sourcePath}`)

  // Verify the file exists after operation
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Failed to symlink binary to ${targetPath}`)
  }
}

async function installSandboxHelper() {
  const platform = os.platform()
  const homedir = os.homedir()

  // macOS uses sandbox-exec built into the OS — no helper needed
  if (platform === "darwin") return

  let helperBinaryName
  let nodePkgPattern

  if (platform === "linux") {
    helperBinaryName = "synergy-sandbox-linux"
    nodePkgPattern = "synergy-sandbox-linux-"
  } else if (platform === "win32") {
    helperBinaryName = "synergy-sandbox-windows.exe"
    nodePkgPattern = "synergy-sandbox-windows-"
  } else {
    console.warn("Unsupported platform for sandbox helper:", platform)
    return
  }

  const destDir = path.join(homedir, ".synergy", "sandbox-helper")
  const destPath = path.join(destDir, helperBinaryName)

  // Idempotent: skip if already installed
  if (fs.existsSync(destPath)) return

  // Search for the helper in node_modules/@ericsanchezok/
  const scopeDir = path.join(__dirname, "..", "node_modules", "@ericsanchezok")
  let found = false

  if (fs.existsSync(scopeDir)) {
    try {
      const entries = fs.readdirSync(scopeDir)
      for (const entry of entries) {
        if (entry.startsWith(nodePkgPattern)) {
          const helperPath = path.join(scopeDir, entry, "bin", helperBinaryName)
          if (fs.existsSync(helperPath)) {
            fs.mkdirSync(destDir, { recursive: true })
            fs.copyFileSync(helperPath, destPath)
            if (platform === "linux") {
              fs.chmodSync(destPath, 0o755)
            }
            console.log(`Sandbox helper installed: ${destPath}`)
            found = true
            break
          }
        }
      }
    } catch {}
  }

  if (!found) {
    console.warn(`Sandbox helper not found in node_modules. Sandbox will gracefully degrade.`)
  }
}

async function main() {
  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      await installSandboxHelper()
      return
    }

    const { binaryPath, binaryName } = findBinary()
    symlinkBinary(binaryPath, binaryName)
    await installSandboxHelper()
  } catch (error) {
    console.error("Failed to setup synergy binary:", error.message)
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  console.error("Postinstall script error:", error.message)
  process.exit(0)
}
