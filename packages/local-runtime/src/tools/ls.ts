import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import * as path from "path"
import DESCRIPTION from "./ls.txt"
import { FileView } from "../file/view"
import { Ripgrep } from "../file/ripgrep"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"

export const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
]

const LIMIT = 100

export const ListTool = Tool.define(
  "list",
  {
    description: DESCRIPTION,
    parameters: z.object({
      path: z.string().describe("Directory to list. Relative paths resolve within the selected Workspace.").optional(),
      ignore: z.array(z.string()).describe("List of glob patterns to ignore").optional(),
    }),
    async execute(params, ctx) {
      const searchPath = FileView.resolve(params.path || ".")

      await ctx.ask({
        permission: "list",
        patterns: [searchPath],
        metadata: {
          path: searchPath,
        },
      })

      const TIMEOUT_MS = ToolTimeout.DEFAULTS.listMs
      const ignoreGlobs = IGNORE_PATTERNS.map((p) => `!${p}*`).concat(params.ignore?.map((p) => `!${p}`) || [])
      const files = []
      let timedOut = false

      // Combine local timeout with session abort signal
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
      const combinedSignal = ctx.abort ? AbortSignal.any([ctx.abort, timeoutSignal]) : timeoutSignal

      try {
        for await (const file of Ripgrep.files({ cwd: searchPath, glob: ignoreGlobs, signal: combinedSignal })) {
          files.push(file.replaceAll("\\", "/"))
          if (files.length >= LIMIT) break
        }
      } catch (error) {
        if (!timeoutSignal.aborted) throw error
        // Subprocess was killed — check if it was our timeout
        if (timeoutSignal.aborted && !ctx.abort?.aborted) {
          timedOut = true
        }
      }

      ctx.abort?.throwIfAborted()
      if (timedOut) {
        throw new Error(
          `list stopped after ${TIMEOUT_MS / 1_000}s before completing the listing.\n` +
            `The directory may be too large. Specify a more specific path or add ignore patterns.`,
        )
      }

      const truncated = files.length >= LIMIT

      // Build directory structure
      const dirs = new Set<string>()
      const filesByDir = new Map<string, string[]>()

      for (const file of files) {
        const dir = path.posix.dirname(file)
        const parts = dir === "." ? [] : dir.split("/")

        // Add all parent directories
        for (let i = 0; i <= parts.length; i++) {
          const dirPath = i === 0 ? "." : parts.slice(0, i).join("/")
          dirs.add(dirPath)
        }

        // Add file to its directory
        if (!filesByDir.has(dir)) filesByDir.set(dir, [])
        filesByDir.get(dir)!.push(path.posix.basename(file))
      }

      function renderDir(dirPath: string, depth: number): string {
        const indent = "  ".repeat(depth)
        let output = ""

        if (depth > 0) {
          output += `${indent}${path.posix.basename(dirPath)}/\n`
        }

        const childIndent = "  ".repeat(depth + 1)
        const children = Array.from(dirs)
          .filter((d) => path.posix.dirname(d) === dirPath && d !== dirPath)
          .sort()

        // Render subdirectories first
        for (const child of children) {
          output += renderDir(child, depth + 1)
        }

        // Render files
        const dirFiles = filesByDir.get(dirPath) || []
        for (const file of dirFiles.sort()) {
          output += `${childIndent}${file}\n`
        }

        return output
      }

      const output = `${searchPath || "."}/\n` + renderDir(".", 0)

      return {
        title: FileView.relative(searchPath),
        metadata: {
          count: files.length,
          truncated: files.length >= LIMIT,
        },
        output,
      }
    },
  },
  { requiresWorkspace: true },
)
