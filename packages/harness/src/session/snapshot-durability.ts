import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "../lifecycle/context"
import { SnapshotGit } from "./snapshot-git"

export namespace SnapshotDurability {
  const state = RuntimeContext.state(() => ({
    devices: new Map<number, Promise<boolean>>(),
    version: undefined as Promise<boolean> | undefined,
  }))

  export function mounts(output: string) {
    return output.split("\n").flatMap((line) => {
      const match = /.+ on (.+) \(([^)]+)\)$/.exec(line)
      if (!match) return []
      return [
        {
          path: match[1]!.replace(/\\([0-7]{3})/g, (_, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
          ),
          flags: match[2]!.split(",").map((flag) => flag.trim()),
        },
      ]
    })
  }

  async function localAPFS(device: number) {
    const proc = Bun.spawn(["/sbin/mount"], { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(5000) })
    try {
      const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      if (code !== 0 || output.length > 1024 * 1024) return false
      const matching = (
        await Promise.all(
          mounts(output)
            .filter((mount) => mount.flags.includes("local") && mount.flags.includes("apfs"))
            .map(async (mount) => {
              const stat = await fs.stat(mount.path).catch(() => undefined)
              return stat?.dev === device ? mount : undefined
            }),
        )
      ).filter((mount) => mount !== undefined)
      return (
        matching.length > 0 && matching.every((mount) => mount.flags.includes("apfs") && mount.flags.includes("local"))
      )
    } finally {
      if (proc.exitCode === null) proc.kill()
      await proc.exited
    }
  }

  export async function treeOptions(repository: string, signal?: AbortSignal) {
    if (process.platform !== "darwin") return []
    signal?.throwIfAborted()
    const cache = state()
    const device = (await fs.stat(repository)).dev
    if (!cache.devices.has(device))
      cache.devices.set(
        device,
        localAPFS(device).catch(() => false),
      )
    if (!(await cache.devices.get(device))) return []
    cache.version ??= SnapshotGit.run(["git", "--version"], path.dirname(repository))
      .then((result) => {
        const version = /git version (\d+)\.(\d+)/.exec(result.text)
        return (
          result.exitCode === 0 &&
          !!version &&
          (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 36))
        )
      })
      .catch(() => false)
    if (!(await cache.version)) return []
    signal?.throwIfAborted()
    // Provenance: https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsyncMethod
    // https://github.com/git/git/blob/v2.55.0/cache-tree.c (ODB transaction).
    // Batch keeps a full durability barrier on supported local filesystems;
    // the repository's object, pack-metadata and reference fsync set is intact.
    return ["-c", "core.fsyncMethod=batch"]
  }
}
