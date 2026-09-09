import { copyFile, mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { resolveSandboxAsset, type SandboxRuntimeTarget } from "./sandbox-assets"

export async function stageWorkspaceSandbox(directory: string, target: SandboxRuntimeTarget, assetsRoot?: string) {
  const asset = resolveSandboxAsset(target, { assetsRoot, required: true })
  if (!asset) return
  const filename = path.basename(asset.relativePath)
  const destination = path.join(directory, "assets", filename)
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(asset.sourcePath, destination)
  await chmod(destination, 0o755)
  await Bun.write(
    path.join(directory, "helper-assets.js"),
    [
      'import { fileURLToPath } from "node:url"',
      "export function packagedSandboxHelper() {",
      `  return { platform: ${JSON.stringify(target.os)}, path: fileURLToPath(new URL(${JSON.stringify(`./assets/${filename}`)}, import.meta.url)), sha256: ${JSON.stringify(asset.sha256)} }`,
      "}",
      "",
    ].join("\n"),
  )
}
