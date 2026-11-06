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

function filesEqual(left, right) {
  try {
    const leftStat = fs.statSync(left)
    const rightStat = fs.statSync(right)
    return (
      leftStat.isFile() &&
      rightStat.isFile() &&
      leftStat.size === rightStat.size &&
      fs.readFileSync(left).equals(fs.readFileSync(right))
    )
  } catch {
    return false
  }
}

async function installSandboxHelper(binaryPath) {
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

  // Prefer the helper embedded in the selected platform package, then support
  // legacy standalone helper packages if one is present.
  const scopeDir = path.join(__dirname, "..", "node_modules", "@ericsanchezok")
  let found = false

  const packagedHelper = path.resolve(path.dirname(binaryPath), "..", "sandbox", helperBinaryName)
  if (fs.existsSync(packagedHelper)) {
    if (!filesEqual(packagedHelper, destPath)) {
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(packagedHelper, destPath)
      if (platform === "linux") fs.chmodSync(destPath, 0o755)
      console.log(`Sandbox helper installed: ${destPath}`)
    }
    found = true
  }

  if (!found && fs.existsSync(scopeDir)) {
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

function pathSynergyCandidate(env = process.env, platform = os.platform()) {
  const pathModule = platform === "win32" ? path.win32 : path
  const delimiter = platform === "win32" ? ";" : path.delimiter
  const executable = platform === "win32" ? "synergy.exe" : "synergy"
  for (const entry of (env.Path ?? env.PATH ?? "").split(delimiter)) {
    if (!entry) continue
    const candidate = pathModule.join(entry, executable)
    if (fs.existsSync(candidate)) return candidate
  }
}

export function desktopRuntimeCandidate(options = {}) {
  const platform = options.platform ?? os.platform()
  const homedir = options.homedir ?? os.homedir()
  const env = options.env ?? process.env
  const existsSync = options.existsSync ?? fs.existsSync
  if (platform === "darwin") return "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy"
  if (platform === "linux") return "/opt/Synergy/resources/synergy/bin/synergy"
  if (platform !== "win32") return

  const localAppData = env.LOCALAPPDATA ?? path.win32.join(homedir, "AppData", "Local")
  const standard = path.win32.join(localAppData, "Programs", "Synergy", "resources", "synergy", "bin", "synergy.exe")
  if (existsSync(standard)) return standard

  for (const entry of (env.Path ?? env.PATH ?? "").split(";")) {
    if (!entry) continue
    const launcher = path.win32.join(entry, "synergy.cmd")
    const runtime = path.win32.resolve(entry, "..", "resources", "synergy", "bin", "synergy.exe")
    if (existsSync(launcher) && existsSync(runtime)) return runtime

    const directRuntime = path.win32.join(entry, "synergy.exe")
    if (directRuntime.toLowerCase().endsWith("\\resources\\synergy\\bin\\synergy.exe") && existsSync(directRuntime)) {
      return directRuntime
    }
  }
}

export function warnAboutStandaloneInstallation(options = {}) {
  const platform = options.platform ?? os.platform()
  const homedir = options.homedir ?? os.homedir()
  const executable = platform === "win32" ? "synergy.exe" : "synergy"
  const standalonePath = path.join(homedir, ".synergy", "bin", executable)
  if (!fs.existsSync(standalonePath)) return false

  console.warn("Warning: another Synergy installation channel is already present.")
  console.warn(`  - standalone: ${standalonePath}`)
  const activePath = pathSynergyCandidate(options.env, platform)
  if (activePath) console.warn(`  - PATH currently resolves synergy to: ${activePath}`)
  console.warn("The package-manager installation will continue and will not remove the standalone installation.")
  console.warn(
    "After installation, run 'synergy doctor' and remove extra channels with 'synergy uninstall --installation-only --method standalone'.",
  )
  return true
}

export function warnAboutDesktopInstallation(options = {}) {
  const desktopPath = desktopRuntimeCandidate(options)
  const existsSync = options.existsSync ?? fs.existsSync
  if (!desktopPath || !existsSync(desktopPath)) return false

  console.warn("Warning: another Synergy installation channel is already present.")
  console.warn(`  - desktop: ${desktopPath}`)
  const activePath = pathSynergyCandidate(options.env, options.platform)
  if (activePath) console.warn(`  - PATH currently resolves synergy to: ${activePath}`)
  console.warn("The package-manager installation will continue and will not remove the Desktop installation.")
  console.warn("After installation, run 'synergy doctor' and manage Desktop updates or removal from the Synergy app.")
  return true
}

function warnAboutOtherInstallations() {
  try {
    warnAboutStandaloneInstallation()
    warnAboutDesktopInstallation()
  } catch {}
}

async function main() {
  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      const { binaryPath } = findBinary()
      await installSandboxHelper(binaryPath)
    } else {
      const { binaryPath, binaryName } = findBinary()
      symlinkBinary(binaryPath, binaryName)
      await installSandboxHelper(binaryPath)
    }
    warnAboutOtherInstallations()
  } catch (error) {
    console.error("Failed to setup synergy binary:", error.message)
    process.exit(1)
  }
}

if (process.env.SYNERGY_POSTINSTALL_LIBRARY_MODE !== "1") {
  try {
    main()
  } catch (error) {
    console.error("Postinstall script error:", error.message)
    process.exit(1)
  }
}
