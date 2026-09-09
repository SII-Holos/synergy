import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, copyFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CUA_DRIVER_RELEASE as release } from "../src/computer/release"

export async function prepareComputerDriver() {
  if (process.platform !== "darwin") return
  const destination = path.resolve(import.meta.dir, "../build/computer")
  await mkdir(destination, { recursive: true })
  for (const name of ["LICENSE.txt", "NOTICE.txt"])
    await copyFile(path.resolve(import.meta.dir, "../build/computer-notices", name), path.join(destination, name))
  const executable = path.join(destination, "cua-driver")
  if (await Bun.file(executable).exists()) {
    const hash = createHash("sha256")
      .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
      .digest("hex")
    if (hash === release.executableSha256) return
  }
  const stage = await mkdtemp(path.join(tmpdir(), "synergy-computer-build-"))
  try {
    const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.archive}`
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok || !response.body) throw new Error(`Cua Driver download failed (${response.status}).`)
    const archive = path.join(stage, release.archive)
    const writer = Bun.file(archive).writer()
    const hash = createHash("sha256")
    let size = 0
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > release.maxBytes) throw new Error("Cua Driver archive exceeds its size limit.")
        hash.update(chunk)
        writer.write(chunk)
      }
    } finally {
      await writer.end()
    }
    if (hash.digest("hex") !== release.sha256) throw new Error("Cua Driver archive checksum mismatch.")
    const extraction = Bun.spawn(["tar", "-xzf", archive, "-C", stage, "cua-driver"], {
      stdout: "ignore",
      stderr: "inherit",
    })
    if ((await extraction.exited) !== 0) throw new Error("Cua Driver extraction failed.")
    const extracted = path.join(stage, "cua-driver")
    if (
      createHash("sha256")
        .update(new Uint8Array(await Bun.file(extracted).arrayBuffer()))
        .digest("hex") !== release.executableSha256
    )
      throw new Error("Cua Driver executable checksum mismatch.")
    await mkdir(destination, { recursive: true })
    const pending = path.join(destination, `cua-driver.${process.pid}.tmp`)
    await copyFile(extracted, pending)
    await chmod(pending, 0o755)
    await rename(pending, executable)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
if (import.meta.main) await prepareComputerDriver()
