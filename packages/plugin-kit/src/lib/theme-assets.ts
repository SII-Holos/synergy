import fs from "fs"
import path from "path"
import { parseTheme, type Theme } from "@ericsanchezok/synergy-plugin/theme"
import { resolveUnder } from "./artifact-assets.js"

export interface ThemeAssetContribution {
  kind: string
  id: string
  path?: string
}

export interface ValidatedThemeAsset {
  contribution: ThemeAssetContribution & { kind: "ui.theme"; path: string }
  file: string
  theme: Theme
}

export function validateThemeAsset(
  root: string,
  contribution: ThemeAssetContribution,
): ValidatedThemeAsset | undefined {
  if (contribution.kind !== "ui.theme") return undefined
  if (!contribution.path) throw new Error(`Theme "${contribution.id}" does not declare an asset path`)
  const file = resolveUnder(root, contribution.path)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Theme "${contribution.id}" asset is missing: ${contribution.path}`)
  }

  let input: unknown
  try {
    input = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(
      `Theme "${contribution.id}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const theme = parseTheme(input)
  if (theme.id !== contribution.id) {
    throw new Error(`Theme asset id "${theme.id}" does not match contribution id "${contribution.id}"`)
  }
  return {
    contribution: contribution as ValidatedThemeAsset["contribution"],
    file: path.resolve(file),
    theme,
  }
}

export function validateThemeAssets(root: string, contributions: readonly ThemeAssetContribution[]) {
  return contributions.flatMap((contribution) => {
    const result = validateThemeAsset(root, contribution)
    return result ? [result] : []
  })
}
