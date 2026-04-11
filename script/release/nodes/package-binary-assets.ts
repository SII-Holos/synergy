import path from "path"
import { $ } from "bun"

export async function packageBinaryAssets(distDir: string, platformNames: string[]) {
  console.log("\n=== package binary assets ===\n")
  const assetPaths: string[] = []
  for (const name of platformNames) {
    const cwd = path.join(distDir, name)
    const assetName = name.includes("linux") ? `${name}.tar.gz` : `${name}.zip`
    const assetPath = path.join(distDir, assetName)
    await $`rm -f ${assetPath}`.cwd(distDir).nothrow()
    if (name.includes("linux")) {
      await $`tar -czf ${assetPath} *`.cwd(cwd)
    } else {
      await $`zip -r ${assetPath} *`.cwd(cwd)
    }
    assetPaths.push(assetPath)
  }
  return assetPaths
}
