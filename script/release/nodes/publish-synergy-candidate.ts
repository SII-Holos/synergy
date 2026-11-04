import path from "node:path"
import fs from "node:fs/promises"
import { PRESETS_DIST_DIR } from "../shared/packages"
import { packPublicationDirectory } from "../shared/publish-generic"
import { assertNpmArchiveSize, publishPackedArchive } from "../shared/publish-modules"
import { readPackedArchives } from "../../package-install-check"
import { validatePackagedRuntimeArchive } from "./package-binary-assets"

export async function prepareSynergyCandidate(version: string, dist = PRESETS_DIST_DIR) {
  const entries = await fs.readdir(dist, { withFileTypes: true })
  const platformNames = entries
    .filter(
      (entry) =>
        entry.isDirectory() && /^synergy-(darwin|linux|windows)-(x64|arm64)(?:-(baseline|musl))*$/.test(entry.name),
    )
    .map((entry) => entry.name)
  const output = path.join(dist, "npm-packages")
  await fs.mkdir(output, { recursive: true })
  const archives = []
  for (const name of [...platformNames, "synergy"]) {
    const archive = await packPublicationDirectory({
      dir: path.join(dist, name),
      name: `@ericsanchezok/${name}`,
      version,
      archive: path.join(output, `${name}.tgz`),
    })
    if (name !== "synergy") await validatePackagedRuntimeArchive(archive.archive, name, { npm: true })
    console.log(`Prepared ${archive.name}@${version}: ${Bun.file(archive.archive).size} bytes`)
    archives.push(archive)
  }
  for (const archive of await readPackedArchives(path.join(dist, "modules-packages"))) {
    if (archive.version !== version) throw new Error(`Stale module publication version: ${archive.name}`)
    await assertNpmArchiveSize(archive)
  }
  return { archives, platformPackages: platformNames.map((name) => `@ericsanchezok/${name}`), platformNames }
}

export async function publishSynergyCandidate(
  candidate: Awaited<ReturnType<typeof prepareSynergyCandidate>>,
  channel: string,
) {
  for (const archive of candidate.archives) await publishPackedArchive(archive, channel)
  return candidate
}
