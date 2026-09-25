import fs from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import path from "node:path"
import unzipper from "unzipper"
import { z } from "zod"
import type { AppArtifact } from "@ericsanchezok/synergy-plugin/package"
import type { InstalledPackage, InstalledGeneration } from "./generations"
import { sha256File } from "./files"

type Run = (
  command: string[],
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>
const run: Run = async (command, env) => {
  const child = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function inside(root: string, relative: string) {
  if (relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative))
    throw new Error("Application archive contains an unsafe path")
  const filename = path.resolve(root, relative)
  const difference = path.relative(root, filename)
  if (difference === ".." || difference.startsWith(`..${path.sep}`) || path.isAbsolute(difference))
    throw new Error("Application archive escapes its directory")
  return filename
}

async function extractZip(archivePath: string, directory: string) {
  const archive = await unzipper.Open.file(archivePath)
  const links: { filename: string; target: string }[] = []
  const seen = new Set<string>()
  for (const entry of archive.files) {
    const filename = inside(directory, entry.path)
    if (seen.has(filename)) throw new Error("Application archive contains duplicate paths")
    seen.add(filename)
    const mode = entry.externalFileAttributes >>> 16
    if ((mode & 0o170000) === 0o120000) {
      const target = (await entry.buffer()).toString("utf8")
      if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.includes("\\") || target.includes("\0"))
        throw new Error("Application symlink must remain inside its directory")
      inside(directory, path.relative(directory, path.resolve(path.dirname(filename), target)))
      links.push({ filename, target })
    } else if (entry.type === "Directory") await fs.mkdir(filename, { recursive: true })
    else {
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await pipeline(entry.stream(), createWriteStream(filename, { flags: "wx" }))
      await fs.chmod(filename, mode & 0o111 ? 0o755 : 0o644)
    }
  }
  for (const link of links) {
    await fs.mkdir(path.dirname(link.filename), { recursive: true })
    await fs.symlink(link.target, link.filename)
  }
  for (const link of links) inside(directory, path.relative(directory, await fs.realpath(link.filename)))
}

export async function verifyApplicationSignature(executable: string, artifact: AppArtifact, execute: Run = run) {
  if (artifact.signing.type === "checksum") {
    if (!artifact.target.startsWith("linux-")) throw new Error("This platform requires a signed application")
    return
  }
  if (artifact.signing.type === "apple") {
    const suffix = executable.indexOf(".app/")
    if (suffix < 0) throw new Error("A macOS application executable must be inside an app bundle")
    const bundle = executable.slice(0, suffix + 4)
    if ((await execute(["codesign", "--verify", "--deep", "--strict", bundle])).code !== 0)
      throw new Error("Application code signature is invalid")
    const identity = await execute(["codesign", "-dv", "--verbose=4", bundle])
    if (identity.code !== 0 || !identity.stderr.split(/\r?\n/).includes(`TeamIdentifier=${artifact.signing.teamID}`))
      throw new Error("Application signing team does not match its publisher")
    if ((await execute(["spctl", "--assess", "--type", "execute", bundle])).code !== 0)
      throw new Error("Application notarization assessment failed")
    return
  }
  const result = await execute(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s = Get-AuthenticodeSignature -LiteralPath $env:SYNERGY_VERIFY_APP; @{ status = [string]$s.Status; publisher = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' } } | ConvertTo-Json -Compress",
    ],
    { SYNERGY_VERIFY_APP: executable },
  )
  const signature = z.object({ status: z.string(), publisher: z.string() }).parse(JSON.parse(result.stdout))
  if (result.code !== 0 || signature.status !== "Valid" || signature.publisher !== artifact.signing.publisher)
    throw new Error("Application signature or publisher is invalid")
}

export async function prepareApplications(
  directory: string,
  packages: Record<string, InstalledPackage>,
  options: {
    target?: string
    fetch?: (url: string) => Promise<Response>
    verify?: typeof verifyApplicationSignature
  } = {},
) {
  const apps = Object.values(packages).flatMap((pkg) => (pkg.metadata?.kind === "app" ? [pkg.metadata] : []))
  const target = options.target ?? `${process.platform}-${process.arch}`
  const selected: Record<string, string> = {}
  await fs.rm(path.join(directory, "applications.json"), { force: true })
  await fs.rm(path.join(directory, "applications"), { recursive: true, force: true })
  for (const app of apps) {
    const artifact = app.artifacts.find((item) => item.target === target && ["zip", "AppImage"].includes(item.format))
    if (!artifact) throw new Error(`${app.id} has no portable application artifact for ${target}`)
    const destination = path.join(directory, "applications", app.id)
    const archive = path.join(directory, `.application-${app.id}.download`)
    try {
      const response = await (options.fetch ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(300_000) })))(
        artifact.url,
      )
      if (!response.ok || !response.body) throw new Error(`Application download failed: ${response.status}`)
      if (response.url && new URL(response.url).protocol !== "https:")
        throw new Error("Application download requires HTTPS")
      let bytes = 0
      const output = await fs.open(archive, "w", 0o600)
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 4 * 1024 ** 3) throw new Error("Application download exceeds 4 GiB")
          let offset = 0
          while (offset < value.byteLength) {
            const result = await output.write(value, offset, value.byteLength - offset)
            offset += result.bytesWritten
          }
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
        await output.close()
      }
      if ((await sha256File(archive)) !== artifact.sha256) throw new Error(`Application checksum mismatch: ${app.id}`)
      await fs.mkdir(destination, { recursive: true })
      const executable = inside(destination, artifact.executable)
      if (artifact.format === "zip") await extractZip(archive, destination)
      else {
        if (!artifact.target.startsWith("linux-")) throw new Error("AppImage requires Linux")
        await fs.mkdir(path.dirname(executable), { recursive: true })
        await fs.copyFile(archive, executable)
        await fs.chmod(executable, 0o755)
      }
      if (!(await fs.stat(executable)).isFile()) throw new Error("Application executable is missing")
      await (options.verify ?? verifyApplicationSignature)(executable, artifact)
      selected[app.id] = path.relative(directory, executable).split(path.sep).join("/")
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true })
      throw error
    } finally {
      await fs.rm(archive, { force: true })
    }
  }
  if (apps.length) await Bun.write(path.join(directory, "applications.json"), JSON.stringify(selected))
}

export async function launchInstalledApplication(generation: InstalledGeneration, id: string) {
  const apps = z
    .record(z.string(), z.string())
    .parse(await Bun.file(path.join(generation.directory, "applications.json")).json())
  if (!apps[id]) throw new Error(`Application is not installed: ${id}`)
  const executable = inside(generation.directory, apps[id])
  if (generation.files[apps[id]]?.kind !== "file")
    throw new Error("Application executable is outside its sealed generation")
  const command =
    process.platform === "darwin" ? ["open", executable.slice(0, executable.indexOf(".app/") + 4)] : [executable]
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  if (process.platform === "darwin") {
    if ((await child.exited) !== 0) throw new Error("Desktop application could not be opened")
  } else child.unref()
}
