import type { SandboxHelperAsset } from "./sandbox/helper-source"
import { nativeAsset } from "@ericsanchezok/synergy-util/native-assets"
import { readFileSync } from "node:fs"
import { z } from "zod"

export function packagedSandboxHelper(): SandboxHelperAsset | undefined {
  const manifest = nativeAsset("sandbox.json", import.meta.url)
  if (!manifest) return undefined
  const asset = z
    .object({ platform: z.enum(["linux", "win32"]), file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(JSON.parse(readFileSync(manifest, "utf8")))
  const filename = nativeAsset(asset.file, import.meta.url)
  if (!filename || asset.platform !== process.platform)
    throw new Error("Native sandbox package is incomplete or incompatible")
  return { platform: asset.platform, path: filename, sha256: asset.sha256 }
}
