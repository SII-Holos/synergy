import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  copySandboxAsset,
  resolveSandboxAsset,
  sandboxAssetKey,
  type SandboxRuntimeTarget,
} from "../../script/sandbox-assets"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function fixture(target: SandboxRuntimeTarget, binaryName: string, binaryArch = target.arch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-sandbox-release-"))
  temporaryDirectories.push(root)
  const source = path.join(root, sandboxAssetKey(target), binaryName)
  const contents = Buffer.alloc(2_048, 7)
  if (target.os === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(contents)
    contents[4] = 2
    contents[5] = 1
    contents.writeUInt16LE(binaryArch === "x64" ? 62 : 183, 18)
  } else if (target.os === "win32") {
    Buffer.from("MZ").copy(contents)
    contents.writeUInt32LE(0x80, 0x3c)
    Buffer.from("PE\0\0").copy(contents, 0x80)
    contents.writeUInt16LE(binaryArch === "x64" ? 0x8664 : 0xaa64, 0x84)
  }
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, contents, { mode: 0o755 })
  return { root, source, contents }
}

describe("sandbox release assets", () => {
  test("maps baseline variants to the same architecture-specific helper", () => {
    expect(sandboxAssetKey({ os: "linux", arch: "x64", avx2: false })).toBe("linux-x64")
    expect(sandboxAssetKey({ os: "linux", arch: "x64", abi: "musl", avx2: false })).toBe("linux-x64-musl")
    expect(sandboxAssetKey({ os: "win32", arch: "x64" })).toBe("windows-x64")
  })

  test("resolves and hashes the exact Linux helper for a runtime target", async () => {
    const target = { os: "linux", arch: "x64", abi: "musl" } satisfies SandboxRuntimeTarget
    const input = await fixture(target, "synergy-sandbox-linux")
    const asset = resolveSandboxAsset(target, { assetsRoot: input.root, required: true })

    expect(asset?.sourcePath).toBe(input.source)
    expect(asset?.relativePath).toBe(path.join("sandbox", "synergy-sandbox-linux"))
    expect(asset?.sha256).toBe(createHash("sha256").update(input.contents).digest("hex"))
  })

  test("copies the Windows helper into the packaged runtime layout", async () => {
    const target = { os: "win32", arch: "x64" } satisfies SandboxRuntimeTarget
    const input = await fixture(target, "synergy-sandbox-windows.exe")
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-sandbox-output-"))
    temporaryDirectories.push(output)
    const asset = resolveSandboxAsset(target, { assetsRoot: input.root, required: true })
    if (!asset) throw new Error("Expected a Windows sandbox asset")

    copySandboxAsset(asset, output)

    expect(await Bun.file(path.join(output, "sandbox", "synergy-sandbox-windows.exe")).arrayBuffer()).toEqual(
      input.contents.buffer,
    )
  })

  test("fails a required non-macOS build when its helper is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-sandbox-missing-"))
    temporaryDirectories.push(root)

    expect(() => resolveSandboxAsset({ os: "linux", arch: "arm64" }, { assetsRoot: root, required: true })).toThrow(
      /linux-arm64.*required/i,
    )
  })

  test("rejects a helper built for the wrong architecture", async () => {
    const input = await fixture({ os: "linux", arch: "arm64" }, "synergy-sandbox-linux", "x64")

    expect(() =>
      resolveSandboxAsset({ os: "linux", arch: "arm64" }, { assetsRoot: input.root, required: true }),
    ).toThrow(/linux-arm64.*matching 64-bit ELF/i)
  })

  test("does not require a helper for macOS", () => {
    expect(resolveSandboxAsset({ os: "darwin", arch: "arm64" }, { required: true })).toBeUndefined()
  })
})
