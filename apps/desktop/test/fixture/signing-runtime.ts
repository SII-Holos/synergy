import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationGenerations } from "../../../../packages/plugin-host/src/installation/generations"
import { requiredRuntimeArtifactPaths, writeRuntimeManifest } from "../../../../script/release/shared/runtime-contract"

export const runtimeTarget = `synergy-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`

export async function signingRuntime(
  prepare?: (fixture: { root: string; app: string; runtimeDir: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-signing-"))
  const app = path.join(root, "Synergy.app")
  const runtimeDir = path.join(app, "Contents/Resources/synergy")
  try {
    for (const relative of requiredRuntimeArtifactPaths(runtimeTarget)) {
      if (relative === "runtime/generation.json" || relative === "runtime-assets.txt") continue
      const filename = path.join(runtimeDir, relative)
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await fs.writeFile(filename, `${relative}\n`)
    }
    await prepare?.({ root, app, runtimeDir })
    const home = path.join(root, "seed-home")
    const staged = await InstallationGenerations.stage(home)
    await fs.cp(path.join(runtimeDir, "runtime"), staged, { recursive: true })
    const generation = await InstallationGenerations.commit(home, {
      directory: staged,
      hostVersion: "1.2.3",
      roots: {},
      packages: {},
      trustHostCode: true,
    })
    await fs.cp(generation.directory, path.join(runtimeDir, "runtime"), { recursive: true })
    await writeRuntimeManifest(runtimeDir, runtimeTarget)
    return {
      root,
      app,
      runtimeDir,
      generation,
      [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}
