import { NamedError } from "@ericsanchezok/synergy-util/error"
import matter from "gray-matter"
import { z } from "zod"

export namespace ConfigMarkdown {
  export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
  export const SHELL_REGEX = /!`([^`]+)`/g

  export function files(template: string) {
    return Array.from(template.matchAll(FILE_REGEX))
  }

  export function shell(template: string) {
    return Array.from(template.matchAll(SHELL_REGEX))
  }

  export async function parse(filePath: string) {
    const template = await Bun.file(filePath).text()

    try {
      // Pass explicit options so gray-matter skips its content cache: a file
      // whose frontmatter fails to parse must keep throwing on every read.
      // Otherwise the failed parse is cached as data:{} and the same broken
      // file silently loads as an empty manifest on the next parse.
      const md = matter(template, {})
      return md
    } catch (err) {
      throw new FrontmatterError(
        {
          path: filePath,
          message: `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      )
    }
  }

  export const FrontmatterError = NamedError.create(
    "ConfigFrontmatterError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )
}
