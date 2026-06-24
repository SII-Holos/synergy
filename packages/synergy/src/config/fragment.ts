import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { FragmentName } from "./fragment-schema"
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser"

const log = Log.create({ service: "config.fragment" })

type ConfigObject = Record<string, unknown>

/**
 * Load config fragments from a synergy.d/ directory.
 * Files must match the FragmentName pattern: NN-name.jsonc
 * They are loaded in numeric sort order (by the two-digit prefix).
 */
export async function loadFragments(dir: string): Promise<ConfigObject[]> {
  try {
    await fs.access(dir)
  } catch {
    return []
  }

  const entries = await fs.readdir(dir, { withFileTypes: true })
  const fragments = entries
    .filter((entry) => entry.isFile() && FragmentName.test(entry.name))
    .sort((a, b) => {
      const numA = parseInt(a.name.split("-", 1)[0], 10)
      const numB = parseInt(b.name.split("-", 1)[0], 10)
      return numA - numB
    })

  const results: ConfigObject[] = []
  for (const entry of fragments) {
    const filepath = path.join(dir, entry.name)
    try {
      const text = await Bun.file(filepath).text()
      if (!text.trim()) continue
      const errors: ParseError[] = []
      const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
      if (errors.length) {
        log.warn("failed to parse config fragment, skipping", {
          path: filepath,
          errors: errors.map((error) => printParseErrorCode(error.error)),
        })
        continue
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        results.push(parsed)
      }
    } catch (err) {
      log.warn("failed to load config fragment, skipping", {
        path: filepath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}
