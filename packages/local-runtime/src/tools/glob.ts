import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { FileView } from "../file/view"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"

export const GlobTool = Tool.define(
  "glob",
  {
    description: DESCRIPTION,
    parameters: z.object({
      pattern: z.string().describe("The glob pattern to match files against"),
      path: z
        .string()
        .optional()
        .describe(
          `The directory to search in. If not specified, the task’s main and shared project folders will be searched. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
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

      const roots = await FileView.searchRoots(params.path)
      const search = roots[0]

      const TIMEOUT_MS = ToolTimeout.DEFAULTS.globMs
      const limit = 100
      const files = []
      let truncated = false
      let timedOut = false

      // Combine local timeout with session abort signal
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
      const combinedSignal = ctx.abort ? AbortSignal.any([ctx.abort, timeoutSignal]) : timeoutSignal

      try {
        for (const root of roots) {
          for await (const file of Ripgrep.files({
            cwd: root,
            glob: [params.pattern],
            signal: combinedSignal,
          })) {
            if (files.length >= limit) {
              truncated = true
              break
            }
            const full = FileView.resolve(file, root)
            const stats = await FileView.file(full)
              .stat()
              .then((x) => x.mtimeMs)
              .catch(() => 0)
            files.push({
              path: full,
              mtime: stats,
            })
          }
          if (truncated) break
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
          `glob stopped after ${TIMEOUT_MS / 1_000}s before completing the search.\n` +
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
        title: FileView.relative(search),
        metadata: {
          count: files.length,
          truncated,
        },
        output: output.join("\n"),
      }
    },
  },
  { requiresWorkspace: true, activityKind: "search" },
)
