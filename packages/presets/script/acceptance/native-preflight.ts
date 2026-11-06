import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { z } from "zod"

export async function assertNativeAcceptanceReady(directory?: string) {
  const root =
    directory ??
    (process.platform === "win32"
      ? path.join(os.userInfo().homedir, ".synergy-file-locks")
      : path.join("/tmp", `synergy-file-locks-${process.getuid!()}`))
  const file = path.join(root, "workspace-claims-v1.json")
  const bytes = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (bytes === undefined) return { reservations: 0, readers: 0 }
  const { claims } = z
    .object({ claims: z.array(z.object({ kind: z.enum(["use", "task", "operation", "process", "exclusive"]) })) })
    .parse(JSON.parse(bytes))
  const reservations = claims.filter((claim) => claim.kind !== "use").length
  if (reservations)
    throw new Error(
      "Local acceptance is blocked by existing native writer reservations; preserve their evidence and resolve their owning operations before starting a new experiment",
    )
  return { reservations, readers: claims.length }
}
