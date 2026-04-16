import { VERSION_MANAGED_PACKAGE_PATHS } from "./packages"

export async function rewriteVersions(version: string) {
  for (const filePath of VERSION_MANAGED_PACKAGE_PATHS) {
    const original = await Bun.file(filePath).text()
    const updated = original.replaceAll(/"version": "[^"]+"/g, `"version": "${version}"`)
    if (original !== updated) {
      await Bun.write(filePath, updated)
      console.log(`updated version: ${filePath}`)
    }
  }
}
