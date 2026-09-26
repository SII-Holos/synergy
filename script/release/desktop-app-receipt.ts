#!/usr/bin/env bun
import path from "node:path"
import { z } from "zod"
import { AppArtifact } from "../../packages/plugin/src/package"
import { verifyApplicationSignature } from "../../packages/plugin-host/src/installation/applications"
import { sha256File } from "../../packages/plugin-host/src/installation/files"
import { currentRepo } from "../shared/current-repo"
import { DESKTOP_RELEASE_DIR } from "./shared/packages"
import { DesktopAppReceipt, desktopApplicationArtifacts } from "./shared/desktop-app-package"

async function windowsSigning(executable: string): Promise<AppArtifact["signing"]> {
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s = Get-AuthenticodeSignature -LiteralPath $env:SYNERGY_VERIFY_APP; @{ status = [string]$s.Status; publisher = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' } } | ConvertTo-Json -Compress",
    ],
    { env: { ...process.env, SYNERGY_VERIFY_APP: executable }, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Desktop signature inspection failed: ${stderr}`)
  const signature = z.object({ status: z.string(), publisher: z.string() }).parse(JSON.parse(stdout))
  if (signature.status === "Valid" && signature.publisher)
    return { type: "authenticode", publisher: signature.publisher }
  if (signature.status === "NotSigned" && !process.env.WINDOWS_CERTIFICATE?.trim()) return { type: "checksum" }
  throw new Error(`Desktop executable has an invalid signature: ${signature.status}`)
}

export async function recordDesktopApplications(directory: string, version: string, repository: string) {
  const artifacts: AppArtifact[] = []
  for (const { file, artifact } of desktopApplicationArtifacts(version, process.platform)) {
    const arm = artifact.target.endsWith("arm64")
    const executable =
      process.platform === "darwin"
        ? path.join(directory, arm ? "mac-arm64" : "mac", "Synergy.app/Contents/MacOS/Synergy")
        : path.join(directory, "win-unpacked/synergy-desktop.exe")
    const signing: AppArtifact["signing"] =
      process.platform === "darwin"
        ? { type: "apple", teamID: process.env.APPLE_TEAM_ID ?? "" }
        : process.platform === "win32"
          ? await windowsSigning(executable)
          : { type: "checksum" }
    const result = AppArtifact.parse({
      ...artifact,
      url: `https://github.com/${repository}/releases/download/v${version}/${file}`,
      sha256: await sha256File(path.join(directory, file)),
      signing,
    })
    if (process.platform !== "linux") await verifyApplicationSignature(executable, result)
    artifacts.push(result)
  }
  if (!artifacts.length) throw new Error(`No Desktop application targets for ${process.platform}`)
  const output = path.join(directory, `synergy-desktop-app-${process.platform}.json`)
  await Bun.write(output, JSON.stringify(DesktopAppReceipt.parse({ version, artifacts }), null, 2) + "\n")
  return output
}

if (import.meta.main) {
  const version = process.env.SYNERGY_VERSION?.trim()
  if (!version) throw new Error("Desktop application receipts require SYNERGY_VERSION")
  console.log(
    await recordDesktopApplications(path.resolve(process.argv[2] ?? DESKTOP_RELEASE_DIR), version, await currentRepo()),
  )
}
