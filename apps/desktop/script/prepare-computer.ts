import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, copyFile, chmod } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { CUA_DRIVER_RELEASE as release } from "../src/computer/release"
import { ComputerBuildProgress } from "./prepare-computer-progress"

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

export async function checkComputerDriverCache(input: {
  executable: string
  receiptFile: string
  recipe: string
  progress: ComputerBuildProgress
}) {
  return input.progress.step("Checking driver cache", async () => {
    const receipt = Receipt.safeParse(
      await Bun.file(input.receiptFile)
        .json()
        .catch(() => undefined),
    )
    if (!receipt.success) input.progress.log("No valid build receipt; rebuilding driver")
    else if (receipt.data.recipe !== input.recipe) input.progress.log("Build inputs changed; rebuilding driver")
    else if (!(await Bun.file(input.executable).exists()))
      input.progress.log("Cached driver is missing; rebuilding driver")
    else if ((await hashFile(input.executable)) !== receipt.data.sha256)
      input.progress.log("Cached driver checksum mismatch; rebuilding driver")
    else {
      input.progress.log("Driver cache verified")
      return true
    }
    return false
  })
}

export async function downloadComputerSource(input: {
  archive: string
  url: string
  sha256: string
  maxBytes: number
  progress: ComputerBuildProgress
  signal?: AbortSignal
}) {
  await input.progress.step("Downloading source", async () => {
    input.progress.download(0)
    const response = await fetch(input.url, { signal: input.signal ?? AbortSignal.timeout(300_000) })
    if (!response.ok || !response.body) throw new Error(`Cua source download failed (${response.status}).`)
    const length = Number(response.headers.get("content-length"))
    const encoding = response.headers.get("content-encoding")
    const total =
      Number.isSafeInteger(length) && length > 0 && (!encoding || encoding === "identity") ? length : undefined
    input.progress.download(0, total)
    const writer = Bun.file(input.archive).writer()
    let size = 0
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > input.maxBytes) throw new Error("Cua source exceeds its size limit.")
        writer.write(chunk)
        input.progress.download(size, total)
      }
    } finally {
      await writer.end()
    }
  })
  await input.progress.step("Verifying source", async () => {
    if ((await hashFile(input.archive)) !== input.sha256) throw new Error("Cua source checksum mismatch.")
  })
}

export async function prepareComputerDriver() {
  if (process.platform !== "darwin") return
  const root = path.resolve(import.meta.dir, "..")
  const progress = new ComputerBuildProgress()
  const destination = path.join(root, "build/computer")
  const native = path.join(root, "native/cua")
  const recipe = await progress.step("Checking build inputs", async () =>
    digest(
      JSON.stringify({
        ...release,
        arch: "universal",
        patch: await hashFile(path.join(native, "observation.patch")),
        module: await hashFile(path.join(native, "synergy.rs")),
      }),
    ),
  )
  await mkdir(destination, { recursive: true })
  const executable = path.join(destination, "cua-driver")
  const receiptFile = path.join(destination, "receipt.json")
  if (await checkComputerDriverCache({ executable, receiptFile, recipe, progress })) {
    progress.ready("Reusing verified driver")
    return
  }
  const cacheRoot = path.resolve(root, "../../.artifacts/computer-build")
  const cache = path.join(cacheRoot, recipe)
  await mkdir(cache, { recursive: true })
  const archive = path.join(cacheRoot, `source-${release.commit}.tar.gz`)
  const sourceCached = await progress.step(
    "Checking source cache",
    async () => (await Bun.file(archive).exists()) && (await hashFile(archive)) === release.sourceSha256,
  )
  if (sourceCached) progress.log("Reusing verified source archive")
  else
    await downloadComputerSource({
      archive,
      url: `https://codeload.github.com/trycua/cua/tar.gz/${release.commit}`,
      sha256: release.sourceSha256,
      maxBytes: release.maxBytes,
      progress,
    })
  const source = path.join(cache, `cua-${release.commit}/libs/cua-driver/rust`)
  if (!(await Bun.file(path.join(source, ".synergy-patched")).exists())) {
    await progress.step("Extracting source", () =>
      run(["tar", "-xzf", archive, "-C", cache, `cua-${release.commit}/libs/cua-driver`], root),
    )
    await progress.step("Applying native patch", async () => {
      await run(["patch", "-p1", "-N", "-f", "-i", path.join(native, "observation.patch")], source)
      await copyFile(path.join(native, "synergy.rs"), path.join(source, "crates/platform-macos/src/synergy.rs"))
      await Bun.write(path.join(source, ".synergy-patched"), recipe)
    })
  }
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
  const targetDirectory = path.join(cacheRoot, "target")
  await progress.step("Preparing Rust toolchain", () =>
    run(["rustup", "target", "add", "--toolchain", release.rust, ...targets], source),
  )
  for (const target of targets)
    await progress.step(target.startsWith("aarch64") ? "Building arm64" : "Building x86_64", () =>
      run(
        [
          "cargo",
          `+${release.rust}`,
          "build",
          "--locked",
          "--release",
          "--target-dir",
          targetDirectory,
          "--target",
          target,
          "-p",
          "cua-driver",
          "--bin",
          "cua-driver",
        ],
        source,
      ),
    )
  const stage = await mkdtemp(path.join(destination, "stage-"))
  try {
    const pending = path.join(stage, "cua-driver")
    await progress.step("Combining architectures", () =>
      run(
        [
          "lipo",
          "-create",
          ...targets.map((target) => path.join(targetDirectory, target, "release/cua-driver")),
          "-output",
          pending,
        ],
        source,
      ),
    )
    await progress.step("Verifying universal driver", async () => {
      for (const architecture of ["arm64", "x86_64"]) await run(["lipo", pending, "-verify_arch", architecture], source)
    })
    await progress.step("Saving driver and build receipt", async () => {
      await chmod(pending, 0o755)
      for (const name of ["LICENSE.txt", "NOTICE.txt"])
        await copyFile(path.join(root, "build/computer-notices", name), path.join(destination, name))
      const value = Receipt.parse({
        version: 1,
        recipe,
        sha256: await hashFile(pending),
        architecture: "universal",
        source: release.commit,
        rust: release.rust,
      })
      await rename(pending, executable)
      await Bun.write(receiptFile, JSON.stringify(value, null, 2) + "\n")
    })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  progress.ready()
}
if (import.meta.main) await prepareComputerDriver()
