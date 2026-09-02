import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { ScopeContext } from "../scope/context"
import { trimDiff } from "./edit"
import { RuntimeReloadPath } from "../config/reload-path"
import { RuntimeReloadExecutor } from "../config/reload-executor"
import { formatCompactReloadResult } from "../config/reload-schema"
import { captureWriteDiagnosticsBefore, collectWriteDiagnostics } from "./write-quality"
import { SnapshotSchema } from "@/session/snapshot-schema"
import { diffStats } from "./anchored-file"

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    content: z.string().describe("The content to write to the file"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath)
      ? params.filePath
      : path.join(ScopeContext.current.directory, params.filePath)
    const displayPath = path.relative(ScopeContext.current.directory, filepath)

    const file = Bun.file(filepath)
    const exists = await file.exists()
    const contentOld = exists ? await file.text() : ""
    if (exists) await FileTime.assert(ctx.sessionID, filepath)

    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))

    await ctx.ask({
      permission: "edit",
      patterns: [displayPath],
      metadata: {
        filepath,
        diff,
      },
    })

    const beforeDiagnostics = await captureWriteDiagnosticsBefore()

    await Bun.write(filepath, params.content)
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    })
    const finalContent = await Bun.file(filepath).text()
    const finalDiff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, finalContent))
    const changeSummary = diffStats(finalDiff)
    const filediff = SnapshotSchema.fromContents({
      file: displayPath,
      before: contentOld,
      after: finalContent,
      ...changeSummary,
      preview: finalDiff,
    })
    FileTime.read(ctx.sessionID, filepath)

    const runtimeReloadTargets = RuntimeReloadPath.detectTargetsForFile(filepath)
    const runtimeReloadScope = RuntimeReloadPath.detectScopeForFile(filepath) ?? "auto"
    const builtinSourceWarning = RuntimeReloadPath.builtinSourceEditWarning(filepath)
    const runtimeReload =
      runtimeReloadTargets.length > 0
        ? await RuntimeReloadExecutor.reload({
            targets: runtimeReloadTargets,
            scope: runtimeReloadScope,
            reason: `write:${displayPath}`,
          })
        : undefined

    const diagnostics = await collectWriteDiagnostics(filepath, { before: beforeDiagnostics })
    let output = diagnostics.output

    if (runtimeReload) {
      output += `\n${formatCompactReloadResult(runtimeReload)}\n`
    }
    if (builtinSourceWarning) {
      output += `\n${builtinSourceWarning}\n`
    }

    return {
      title: displayPath,
      metadata: {
        diagnostics: diagnostics.diagnostics,
        diff: finalDiff,
        filediff,
        changeSummary,
        filepath,
        exists,
        runtimeReload,
        builtinSourceWarning,
      },
      output,
    }
  },
})
