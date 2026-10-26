const fs = require("node:fs")
const crypto = require("node:crypto")
const path = require("node:path")
const { requiredRuntimeArtifactPaths } = require("../../../script/release/shared/runtime-layout.cjs")
const hashBuffer = Buffer.allocUnsafe(1024 * 1024)

function sha256File(filename) {
  const hash = crypto.createHash("sha256")
  const descriptor = fs.openSync(filename, "r")
  try {
    let size
    while ((size = fs.readSync(descriptor, hashBuffer)) > 0) hash.update(hashBuffer.subarray(0, size))
    return hash.digest("hex")
  } finally {
    fs.closeSync(descriptor)
  }
}

function runtimeFileIsSafe(runtimeDir, relative) {
  const components = relative.split("/")
  let current = runtimeDir
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    const info = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!info || info.isSymbolicLink()) return false
    if (index < components.length - 1 && !info.isDirectory()) return false
    if (index === components.length - 1 && !info.isFile()) return false
  }
  return true
}

function runtimeFiles(runtimeDir) {
  if (!fs.lstatSync(runtimeDir).isDirectory()) throw new Error("Synergy runtime must be a regular directory")
  const files = []
  const pending = [runtimeDir]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Synergy runtime contains a symbolic link: ${path.relative(runtimeDir, absolute)}`)
      }
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(runtimeDir, absolute).split(path.sep).join("/")
        if (!["package.json", "runtime-manifest.sha256"].includes(relative)) files.push(relative)
      } else throw new Error(`Synergy runtime contains an unsupported file: ${absolute}`)
    }
  }
  return files
}

function inspectRuntimeFiles(runtimeDir, entries, signedFiles = new Set()) {
  for (const file of runtimeFiles(runtimeDir)) {
    if (!entries.has(file)) throw new Error(`Synergy runtime manifest contains an unlisted file: ${file}`)
  }
  const actualEntries = new Map()
  for (const [relative, expected] of entries) {
    const absolute = path.resolve(runtimeDir, relative)
    if (!fs.existsSync(absolute)) throw new Error(`Synergy runtime manifest file is missing: ${relative}`)
    if (!runtimeFileIsSafe(runtimeDir, relative)) {
      throw new Error(`Synergy runtime manifest file is unsafe: ${relative}`)
    }
    const actual = sha256File(absolute)
    const mutable =
      signedFiles.has(absolute) &&
      !["runtime/generation.json", "runtime-assets.txt", "desktop-package.json"].includes(relative)
    if (actual !== expected && !mutable) {
      throw new Error(`Synergy runtime manifest checksum mismatch: ${relative}`)
    }
    actualEntries.set(relative, actual)
  }
  return actualEntries
}

function assertRuntimeAssets(runtimeDir, platform, arch = "x64") {
  const manifestPath = path.join(runtimeDir, "runtime-manifest.sha256")
  if (!fs.existsSync(manifestPath)) throw new Error(`Synergy runtime manifest is missing: ${manifestPath}`)
  runtimeFiles(runtimeDir)
  const entries = new Map()
  for (const line of fs.readFileSync(manifestPath, "utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    const checksum = match?.[1]
    const relative = match?.[2]
    const components = relative?.split("/")
    if (
      !checksum ||
      !relative ||
      relative.startsWith("/") ||
      /[\\\x00-\x1f\x7f]/.test(relative) ||
      /^[A-Za-z]:/.test(relative) ||
      components?.some((component) => !component || component === "." || component === "..")
    ) {
      throw new Error(`Synergy runtime manifest contains an invalid entry: ${manifestPath}`)
    }
    if (entries.has(relative)) throw new Error(`Synergy runtime manifest contains a duplicate entry ${relative}`)
    entries.set(relative, checksum)
  }
  if (platform) {
    const architecture = { 0: "ia32", 1: "x64", 3: "arm64" }[arch] ?? String(arch)
    const target = `synergy-${platform === "win32" ? "windows" : platform}-${architecture}`
    for (const relative of requiredRuntimeArtifactPaths(target)) {
      if (!entries.has(relative)) {
        throw new Error(`Synergy runtime manifest is missing required entry ${relative}: ${runtimeDir}`)
      }
    }
  }
  return inspectRuntimeFiles(runtimeDir, entries)
}

function writeRuntimeInventory(runtimeDir, entries) {
  const lines = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  fs.writeFileSync(
    path.join(runtimeDir, "runtime-manifest.sha256"),
    lines.map(([relative, checksum]) => `${checksum}  ${relative}\n`).join(""),
  )
}

function prepareRuntimeSeal(runtimeDir) {
  const entries = assertRuntimeAssets(runtimeDir)
  const manifestPath = path.join(runtimeDir, "runtime-manifest.sha256")
  const originalManifest = fs.readFileSync(manifestPath, "utf8")
  const generationPath = path.join(runtimeDir, "runtime/generation.json")
  if (!entries.has("runtime/generation.json")) throw new Error("Synergy runtime is missing its installation seed")
  const generation = JSON.parse(fs.readFileSync(generationPath, "utf8"))
  const files = [...entries].filter(
    ([relative]) => relative.startsWith("runtime/") && relative !== "runtime/generation.json",
  )
  if (
    generation.version !== 1 ||
    !generation.files ||
    Object.keys(generation.files).length !== files.length ||
    files.some(([relative, checksum]) => {
      const entry = generation.files[relative.slice("runtime/".length)]
      return entry?.kind !== "file" || entry.sha256 !== checksum
    })
  ) {
    throw new Error("Bundled installation seed integrity mismatch")
  }
  return (signedFiles) => {
    const actual = inspectRuntimeFiles(runtimeDir, entries, signedFiles)
    if (fs.readFileSync(manifestPath, "utf8") !== originalManifest) {
      throw new Error("Synergy runtime manifest changed during signing")
    }
    for (const relative of Object.keys(generation.files)) {
      generation.files[relative].sha256 = actual.get(`runtime/${relative}`)
    }
    fs.writeFileSync(generationPath, JSON.stringify(generation))
    actual.set("runtime/generation.json", sha256File(generationPath))
    writeRuntimeInventory(runtimeDir, actual)
  }
}

exports.assertRuntimeAssets = assertRuntimeAssets
exports.prepareRuntimeSeal = prepareRuntimeSeal
exports.sha256File = sha256File
exports.writeRuntimeInventory = writeRuntimeInventory
