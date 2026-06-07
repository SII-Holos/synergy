import z from "zod"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./save-file.txt"
import { Tool } from "./tool"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { LSP } from "../lsp"
import { RuntimeReload } from "../runtime/reload"
import { assertInsideOrAsk, displayPath, ensureParentDir, hashlineHeaderFor, resolveFilePath } from "./anchored-file"
import { stripHashlineDisplayPrefixes } from "../hashline/format"

export const SaveFileTool = Tool.define("save_file", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to write"),
    content: z.string().describe("The full file content to write"),
  }),
  async execute(params, ctx) {
    const filePath = resolveFilePath(params.filePath)
    const title = displayPath(filePath)
    await assertInsideOrAsk(filePath, ctx)

    return FileTime.withLock(
      filePath,
      async () => {
        const file = Bun.file(filePath)
        const exists = await file.exists()
        const oldContent = exists ? await file.text() : ""
        if (exists) await FileTime.assert(ctx.sessionID, filePath).catch(() => {})

        const content = stripHashlineDisplayPrefixes(params.content)
        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, content))
        await ctx.ask({ permission: "edit", patterns: [title], metadata: { filepath: filePath, diff } })

        await ensureParentDir(filePath)
        await Bun.write(filePath, content)
        await Bus.publish(File.Event.Edited, { file: filePath })
        FileTime.read(ctx.sessionID, filePath)

        await LSP.touchFile(filePath, true)
        const runtimeReloadTargets = RuntimeReload.detectTargetsForFile(filePath)
        const runtimeReloadScope = RuntimeReload.detectScopeForFile(filePath) ?? "auto"
        const runtimeReload = runtimeReloadTargets.length
          ? await RuntimeReload.reload({
              targets: runtimeReloadTargets,
              scope: runtimeReloadScope,
              reason: `save_file:${title}`,
            })
          : undefined
        const builtinSourceWarning = RuntimeReload.builtinSourceEditWarning(filePath)
        const header = hashlineHeaderFor(ctx.sessionID, filePath, content)
        let output = header
        if (runtimeReload) output += `\nRuntime reload applied: ${runtimeReload.executed.join(",")}`
        if (builtinSourceWarning) output += `\n${builtinSourceWarning}`

        return {
          title,
          output,
          metadata: {
            filepath: filePath,
            path: title,
            tag: header.match(/#([0-9A-F]{4})\]$/)?.[1],
            diff,
            exists,
            runtimeReload,
            builtinSourceWarning,
          },
        }
      },
      { signal: ctx.abort },
    )
  },
})
