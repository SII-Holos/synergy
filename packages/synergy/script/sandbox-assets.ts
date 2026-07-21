import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface SandboxRuntimeTarget {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export interface SandboxAsset {
  sourcePath: string
  relativePath: string
  sha256: string
}

export interface ResolveSandboxAssetOptions {
  assetsRoot?: string
  required?: boolean
}

const ELF_MACHINE = { x64: 62, arm64: 183 } as const
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 } as const

export function sandboxAssetKey(target: SandboxRuntimeTarget): string {
  const platform = target.os === "win32" ? "windows" : target.os
  return [platform, target.arch, target.abi].filter(Boolean).join("-")
}

export function sandboxAssetBinaryName(target: SandboxRuntimeTarget): string | undefined {
  if (target.os === "linux") return "synergy-sandbox-linux"
  if (target.os === "win32") return "synergy-sandbox-windows.exe"
  return undefined
}

function assertSandboxAssetFormat(target: SandboxRuntimeTarget, contents: Buffer): void {
  if (target.os === "linux") {
    const validElf =
      contents.length >= 20 &&
      contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      contents[4] === 2 &&
      contents[5] === 1 &&
      contents.readUInt16LE(18) === ELF_MACHINE[target.arch]
    if (!validElf) throw new Error(`Sandbox asset ${sandboxAssetKey(target)} is not a matching 64-bit ELF binary`)
    return
  }

  if (target.os === "win32") {
    const peOffset = contents.length >= 64 ? contents.readUInt32LE(0x3c) : -1
    const validPe =
      peOffset >= 0 &&
      peOffset + 6 <= contents.length &&
      contents.subarray(0, 2).equals(Buffer.from("MZ")) &&
      contents.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0")) &&
      contents.readUInt16LE(peOffset + 4) === PE_MACHINE[target.arch]
    if (!validPe) throw new Error(`Sandbox asset ${sandboxAssetKey(target)} is not a matching PE binary`)
  }
}

export function resolveSandboxAsset(
  target: SandboxRuntimeTarget,
  options: ResolveSandboxAssetOptions = {},
): SandboxAsset | undefined {
  const binaryName = sandboxAssetBinaryName(target)
  if (!binaryName) return

  const assetsRoot =
    options.assetsRoot ??
    process.env.SYNERGY_SANDBOX_ASSETS_DIR ??
    path.resolve(import.meta.dir, "..", "sandbox-assets")
  const key = sandboxAssetKey(target)
  const sourcePath = path.join(assetsRoot, key, binaryName)
  if (!fs.existsSync(sourcePath)) {
    if (options.required) {
      throw new Error(`Sandbox asset ${key}/${binaryName} is required but was not found in ${assetsRoot}`)
    }
    return
  }

  const stat = fs.statSync(sourcePath)
  if (!stat.isFile() || stat.size < 1_024) {
    throw new Error(`Sandbox asset ${key}/${binaryName} is not a valid helper binary`)
  }

  const contents = fs.readFileSync(sourcePath)
  assertSandboxAssetFormat(target, contents)

  return {
    sourcePath,
    relativePath: path.join("sandbox", binaryName),
    sha256: createHash("sha256").update(contents).digest("hex"),
  }
}

export function copySandboxAsset(asset: SandboxAsset, targetDirectory: string): void {
  const destination = path.join(targetDirectory, asset.relativePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(asset.sourcePath, destination)
  if (!destination.endsWith(".exe")) fs.chmodSync(destination, 0o755)
}

export function assertPackagedSandboxAsset(target: SandboxRuntimeTarget, targetDirectory: string): void {
  const binaryName = sandboxAssetBinaryName(target)
  if (!binaryName) return
  const packaged = path.join(targetDirectory, "sandbox", binaryName)
  if (!fs.existsSync(packaged) || !fs.statSync(packaged).isFile()) {
    throw new Error(`Packaged runtime ${sandboxAssetKey(target)} is missing sandbox/${binaryName}`)
  }
}
