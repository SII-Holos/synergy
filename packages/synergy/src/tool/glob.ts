import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { ScopeContext } from "../scope/context"

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? ScopeContext.current.directory
    search = path.isAbsolute(search) ? search : path.resolve(ScopeContext.current.directory, search)

    const TIMEOUT_MS = 15_000
    const limit = 100
    const files = []
    let truncated = false
    let timedOut = false

    // Combine local timeout with session abort signal
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
    const combinedSignal = ctx.abort ? AbortSignal.any([ctx.abort, timeoutSignal]) : timeoutSignal

    try {
      for await (const file of Ripgrep.files({
        cwd: search,
        glob: [params.pattern],
        signal: combinedSignal,
      })) {
        if (files.length >= limit) {
          truncated = true
          break
        }
        const full = path.resolve(search, file)
        const stats = await Bun.file(full)
          .stat()
          .then((x) => x.mtime.getTime())
          .catch(() => 0)
        files.push({
          path: full,
          mtime: stats,
        })
      }
    } catch {
      // Subprocess was killed — check if it was our timeout
      if (timeoutSignal.aborted && !ctx.abort?.aborted) {
        timedOut = true
      }
    }

    if (timedOut) {
      throw new Error(
        `glob stopped after ${TIMEOUT_MS}ms before completing the search.\n` +
          `Use a more specific glob pattern or specify a smaller directory path.`,
      )
    }

    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    if (files.length === 0) output.push("No files found")
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push("(Results are truncated. Consider using a more specific path or pattern.)")
      }
    }

    return {
      title: path.relative(ScopeContext.current.directory, search),
      metadata: {
        count: files.length,
        truncated,
      },
      output: output.join("\n"),
    }
  },
})
