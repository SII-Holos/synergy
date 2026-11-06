const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

function mapPlatform(input) {
  switch (input) {
    case "darwin":
      return "darwin"
    case "linux":
      return "linux"
    case "win32":
      return "windows"
    default:
      return input
  }
}

function mapArch(input) {
  switch (input) {
    case "x64":
      return "x64"
    case "arm64":
      return "arm64"
    case "arm":
      return "arm"
    default:
      return input
  }
}

function commandOutput(command, args) {
  try {
    const result = childProcess.spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.error) return ""
    return `${result.stdout || ""}${result.stderr || ""}`
  } catch {
    return ""
  }
}

function detectArch(platform, arch) {
  if (platform === "darwin" && arch === "x64") {
    const translated = commandOutput("sysctl", ["-n", "sysctl.proc_translated"]).trim()
    if (translated === "1") return "arm64"
  }
  return arch
}

function detectMusl(platform) {
  if (platform !== "linux") return false
  if (fs.existsSync("/etc/alpine-release")) return true
  return /musl/i.test(commandOutput("ldd", ["--version"]))
}

function detectBaseline(platform, arch) {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return !/avx2/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    return commandOutput("sysctl", ["-n", "hw.optional.avx2_0"]).trim() !== "1"
  }
  return false
}

function detectRuntimeTarget() {
  const platform = mapPlatform(os.platform())
  const arch = detectArch(platform, mapArch(os.arch()))
  return {
    platform,
    arch,
    musl: detectMusl(platform),
    baseline: detectBaseline(platform, arch),
  }
}

function candidatePackageNames(scope = "@ericsanchezok") {
  const target = detectRuntimeTarget()
  const base = `${scope}/synergy-${target.platform}-${target.arch}`
  const candidates = []

  if (target.baseline && target.musl) candidates.push(`${base}-baseline-musl`)
  if (target.musl) candidates.push(`${base}-musl`)
  if (target.baseline) candidates.push(`${base}-baseline`)
  candidates.push(base)

  return [...new Set(candidates)]
}

function packageBinaryName() {
  return os.platform() === "win32" ? "synergy.exe" : "synergy"
}

function findInstalledBinary(startDir) {
  const binary = packageBinaryName()
  let current = startDir
  for (;;) {
    const modules = path.join(current, "node_modules")
    if (fs.existsSync(modules)) {
      for (const packageName of candidatePackageNames()) {
        const candidate = path.join(modules, packageName, "bin", binary)
        if (fs.existsSync(candidate)) return candidate
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

module.exports = {
  candidatePackageNames,
  detectRuntimeTarget,
  findInstalledBinary,
  packageBinaryName,
}
