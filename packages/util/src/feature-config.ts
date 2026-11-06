import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { FeaturePreferences } from "./features"

export const FEATURE_CONFIG_FILENAME = "140-features.jsonc"
const Document = z.object({ $schema: z.string().optional(), features: FeaturePreferences.optional() }).strict()

export function parseFeatureConfig(text: string): FeaturePreferences {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error("Invalid experimental feature configuration")
  return Document.parse(value).features ?? { optIn: [] }
}

export async function readFeaturePreferences(configDirectory: string): Promise<FeaturePreferences> {
  const filename = path.join(configDirectory, "synergy.d", FEATURE_CONFIG_FILENAME)
  const text = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  return text === undefined ? { optIn: [] } : parseFeatureConfig(text)
}
