import path from "node:path"
import fs from "node:fs/promises"
import { PRESETS_DIST_DIR } from "../shared/packages"
import { publishDirectory } from "../shared/publish-generic"

export async function publishSynergyCandidate(version: string, channel: string) {
  const entries = await fs.readdir(PRESETS_DIST_DIR, { withFileTypes: true })
  const platformNames = entries
    .filter(
      (entry) =>
        entry.isDirectory() && /^synergy-(darwin|linux|windows)-(x64|arm64)(?:-(baseline|musl))*$/.test(entry.name),
    )
    .map((entry) => entry.name)
  for (const name of [...platformNames, "synergy"])
    await publishDirectory({ dir: path.join(PRESETS_DIST_DIR, name), name: `@ericsanchezok/${name}`, version, channel })
  return { platformPackages: platformNames.map((name) => `@ericsanchezok/${name}`), platformNames }
}
