import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, copyFile, chmod } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { CUA_DRIVER_RELEASE as release } from "../src/computer/release"

const Receipt = z
  .object({
    version: z.literal(1),
    recipe: z.string(),
    sha256: z.string(),
    architecture: z.string(),
    source: z.string(),
    rust: z.string(),
  })
  .strict()
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
async function hashFile(file: string) {
  return digest(new Uint8Array(await Bun.file(file).arrayBuffer()))
}
async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" })
  if ((await process.exited) !== 0) throw new Error(`Computer build failed: ${command[0]}`)
}

export async function prepareComputerDriver() {
  if (process.platform !== "darwin") return
  const root = path.resolve(import.meta.dir, "..")
  const destination = path.join(root, "build/computer")
  const native = path.join(root, "native/cua")
  const recipe = digest(
    JSON.stringify({
      ...release,
      arch: process.arch,
      patch: await hashFile(path.join(native, "observation.patch")),
      module: await hashFile(path.join(native, "synergy.rs")),
    }),
  )
  await mkdir(destination, { recursive: true })
  const executable = path.join(destination, "cua-driver")
  const receiptFile = path.join(destination, "receipt.json")
  const receipt = Receipt.safeParse(
    await Bun.file(receiptFile)
      .json()
      .catch(() => undefined),
  )
  if (
    receipt.success &&
    receipt.data.recipe === recipe &&
    (await Bun.file(executable).exists()) &&
    (await hashFile(executable)) === receipt.data.sha256
  )
    return
  const cache = path.resolve(root, "../../.artifacts/computer-build", recipe)
  await mkdir(cache, { recursive: true })
  const archive = path.join(cache, "source.tar.gz")
  if (!(await Bun.file(archive).exists()) || (await hashFile(archive)) !== release.sourceSha256) {
    const response = await fetch(`https://codeload.github.com/trycua/cua/tar.gz/${release.commit}`, {
      signal: AbortSignal.timeout(300_000),
    })
    if (!response.ok || !response.body) throw new Error(`Cua source download failed (${response.status}).`)
    const writer = Bun.file(archive).writer()
    let size = 0
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > release.maxBytes) throw new Error("Cua source exceeds its size limit.")
        writer.write(chunk)
      }
    } finally {
      await writer.end()
    }
    if ((await hashFile(archive)) !== release.sourceSha256) throw new Error("Cua source checksum mismatch.")
  }
  const source = path.join(cache, `cua-${release.commit}/libs/cua-driver/rust`)
  if (!(await Bun.file(path.join(source, ".synergy-patched")).exists())) {
    await run(["tar", "-xzf", archive, "-C", cache, `cua-${release.commit}/libs/cua-driver`], root)
    await run(["git", "apply", "--unsafe-paths", path.join(native, "observation.patch")], source)
    await copyFile(path.join(native, "synergy.rs"), path.join(source, "crates/platform-macos/src/synergy.rs"))
    await Bun.write(path.join(source, ".synergy-patched"), recipe)
  }
  await run(
    ["cargo", `+${release.rust}`, "build", "--locked", "--release", "-p", "cua-driver", "--bin", "cua-driver"],
    source,
  )
  const stage = await mkdtemp(path.join(destination, "stage-"))
  try {
    const binary = path.join(source, "target/release/cua-driver")
    const pending = path.join(stage, "cua-driver")
    await copyFile(binary, pending)
    await chmod(pending, 0o755)
    for (const name of ["LICENSE.txt", "NOTICE.txt"])
      await copyFile(path.join(root, "build/computer-notices", name), path.join(destination, name))
    const value = Receipt.parse({
      version: 1,
      recipe,
      sha256: await hashFile(pending),
      architecture: process.arch,
      source: release.commit,
      rust: release.rust,
    })
    await rename(pending, executable)
    await Bun.write(receiptFile, JSON.stringify(value, null, 2) + "\n")
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
if (import.meta.main) await prepareComputerDriver()
