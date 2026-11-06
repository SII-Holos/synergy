import fs from "node:fs"
import { parseSkin } from "@ericsanchezok/synergy-plugin/skin"
import { resolveUnder } from "./artifact-assets.js"

export function validateSkinAssets(
  root: string,
  contributions: readonly { kind: string; id: string; path?: string }[],
) {
  return contributions.flatMap((contribution) => {
    if (contribution.kind !== "ui.skin") return []
    if (!contribution.path) throw new Error(`Skin ${contribution.id} must declare a JSON path`)
    const file = resolveUnder(root, contribution.path)
    const skin = parseSkin(JSON.parse(fs.readFileSync(file, "utf8")))
    if (skin.id !== contribution.id) throw new Error(`Skin ${skin.id} does not match contribution ${contribution.id}`)
    for (const asset of Object.values(skin.assets)) {
      const file = resolveUnder(root, asset.path)
      if (!fs.statSync(file).isFile()) throw new Error(`Skin asset is not a file: ${asset.path}`)
      if (!fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}/`))
        throw new Error(`Skin asset escapes the plugin: ${asset.path}`)
    }
    return [{ contribution, skin }]
  })
}
