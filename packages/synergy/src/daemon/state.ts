import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Installation } from "../global/installation"
import { DaemonPaths } from "./paths"

export namespace DaemonState {
  export const Manifest = z
    .object({
      version: z.string(),
      label: z.string(),
      manager: z.enum(["launchd", "systemd-user", "schtasks"]),
      hostname: z.string(),
      port: z.number().int().positive(),
      url: z.string(),
      connectHostname: z.string().optional(),
      mdns: z.boolean().optional(),
      cors: z.array(z.string()).optional(),
      installedAt: z.number(),
      lastStartedAt: z.number().optional(),
      command: z.array(z.string()).min(1),
      cwd: z.string(),
      logFile: z.string().optional(),
      stdoutLog: z.string().optional(),
      stderrLog: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict()

  export type Manifest = z.infer<typeof Manifest>

  export function resolveLogFile(manifest: Manifest): string {
    return manifest.logFile ?? manifest.stderrLog ?? manifest.stdoutLog ?? DaemonPaths.logFile()
  }

  export async function ensureDirs() {
    const dirs = [fs.mkdir(DaemonPaths.root(), { recursive: true }), fs.mkdir(DaemonPaths.logs(), { recursive: true })]
    if (process.platform === "darwin") {
      dirs.push(fs.mkdir(path.dirname(DaemonPaths.launchAgent("placeholder")), { recursive: true }))
    }
    if (process.platform === "linux") {
      dirs.push(fs.mkdir(DaemonPaths.systemdUserDir(), { recursive: true }))
    }
    await Promise.all(dirs)
  }

  export async function readManifest(): Promise<Manifest | undefined> {
    const file = Bun.file(DaemonPaths.manifest())
    if (!(await file.exists().catch(() => false))) return
    const json = await file.json().catch(() => undefined)
    return Manifest.parse(json)
  }

  export async function writeManifest(input: Omit<Manifest, "version" | "installedAt"> & { installedAt?: number }) {
    await ensureDirs()
    const manifest = Manifest.parse({
      ...input,
      version: Installation.VERSION,
      installedAt: input.installedAt ?? Date.now(),
    })
    await Bun.write(DaemonPaths.manifest(), JSON.stringify(manifest, null, 2) + "\n")
    return manifest
  }

  export async function removeManifest() {
    await fs.rm(DaemonPaths.manifest(), { force: true }).catch(() => {})
  }
}
