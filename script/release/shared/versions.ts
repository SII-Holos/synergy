import { VERSION_MANAGED_PACKAGE_PATHS } from "./packages"
import { versionPackage } from "./package-manifest"

export async function rewriteVersions(version: string) {
  for (const filePath of VERSION_MANAGED_PACKAGE_PATHS) {
    const original = await Bun.file(filePath).text()
    const updated = JSON.stringify(versionPackage(JSON.parse(original), version), null, 2) + "\n"
    if (original !== updated) {
      await Bun.write(filePath, updated)
      console.log(`updated version: ${filePath}`)
    }
  }
}
