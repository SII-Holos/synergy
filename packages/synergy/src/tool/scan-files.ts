import z from "zod"
import DESCRIPTION from "./scan-files.txt"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../scope/instance"
import {
  assertInsideOrAsk,
  displayPath,
  formatRecordedBlock,
  markFileRead,
  readTextFile,
  resolveFilePath,
} from "./anchored-file"

export const ScanFilesTool = Tool.define("scan_files", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("Regex pattern to search for in file contents"),
    path: z.string().optional().describe("Directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.ts")'),
    globs: z.array(z.string()).optional().describe("Include/exclude globs (prefix ! to exclude)"),
  }),
  async execute(params, ctx) {
    if (!params.pattern) throw new Error("pattern is required")
    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      metadata: { pattern: params.pattern, path: params.path, include: params.include, globs: params.globs },
    })

    const searchPath = params.path ? resolveFilePath(params.path) : Instance.directory
    await assertInsideOrAsk(searchPath, ctx)
    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) args.push("--glob", params.include)
    for (const glob of params.globs ?? []) args.push("--glob", glob)
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode === 1)
      return { title: params.pattern, metadata: { matches: 0, files: [], truncated: false }, output: "No files found" }
    if (exitCode !== 0) throw new Error(`ripgrep failed: ${stderr}`)

    const matches = stdout.trim().split(/\r?\n/).filter(Boolean)
    const byFile = new Map<string, number>()
    for (const line of matches) {
      const [filePath] = line.split("|")
      if (!filePath) continue
      byFile.set(filePath, (byFile.get(filePath) ?? 0) + 1)
    }

    const blocks: string[] = []
    const files: string[] = []
    for (const filePath of byFile.keys()) {
      const content = await readTextFile(filePath).catch(() => undefined)
      if (content === undefined) continue
      const { output } = formatRecordedBlock(ctx.sessionID, filePath, content)
      markFileRead(ctx.sessionID, filePath)
      blocks.push(output)
      files.push(displayPath(filePath))
    }

    return {
      title: params.pattern,
      output: blocks.length ? blocks.join("\n\n") : "No files found",
      metadata: { matches: matches.length, files, truncated: false },
    }
  },
})
