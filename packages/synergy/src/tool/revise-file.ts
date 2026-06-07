import z from "zod"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./revise-file.txt"
import { Tool } from "./tool"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { LSP } from "../lsp"
import { RuntimeReload } from "../runtime/reload"
import { formatHashlineBlock } from "../hashline/format"
import { parseHashlinePatch } from "../hashline/patch"
import { applyPatchOps } from "../hashline/revise"
import { SessionHashlineStore } from "../hashline/store"
import { computeTag, normalizeContent } from "../hashline/tag"
import { assertInsideOrAsk, displayPath, resolveFilePath } from "./anchored-file"

export const ReviseFileTool = Tool.define("revise_file", {
  description: DESCRIPTION,
  parameters: z.object({
    input: z.string().describe("Hashline patch text beginning with [path#TAG]"),
  }),
  async execute(params, ctx) {
    const patch = parseHashlinePatch(params.input)
    const filePath = resolveFilePath(patch.path)
    const title = displayPath(filePath)
    await assertInsideOrAsk(filePath, ctx)

    return FileTime.withLock(
      filePath,
      async () => {
        const store = SessionHashlineStore.get(ctx.sessionID)
        const stored = store.get(filePath, patch.tag)
        if (stored === undefined) {
          throw new Error(
            `Unknown or stale hashline tag #${patch.tag} for ${patch.path}. Use view_file, scan_files, parse_code, or save_file to get a current [path#TAG] header.`,
          )
        }

        const file = Bun.file(filePath)
        const stats = await file.stat().catch(() => undefined)
        if (!stats) throw new Error(`File not found: ${filePath}`)
        if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)

        const oldContent = normalizeContent(await file.text())
        const liveTag = computeTag(oldContent)
        if (liveTag !== patch.tag) {
          throw new Error(
            `Stale hashline tag #${patch.tag} for ${patch.path}; current file hashes to #${liveTag}. Re-run view_file and retry with the current header.`,
          )
        }

        await FileTime.assert(ctx.sessionID, filePath)
        const newContent = applyPatchOps(oldContent, patch.ops)
        if (newContent === oldContent) {
          return {
            title,
            output: formatHashlineBlock(title, patch.tag, oldContent),
            metadata: {
              filepath: filePath,
              path: title,
              tag: patch.tag,
              applied: false,
              operations: 0,
              diff: "",
              runtimeReload: undefined,
              builtinSourceWarning: undefined,
            },
          }
        }

        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))
        await ctx.ask({ permission: "edit", patterns: [title], metadata: { filepath: filePath, diff } })

        await Bun.write(filePath, newContent)
        await Bus.publish(File.Event.Edited, { file: filePath })
        FileTime.read(ctx.sessionID, filePath)

        await LSP.touchFile(filePath, true)
        const runtimeReloadTargets = RuntimeReload.detectTargetsForFile(filePath)
        const runtimeReloadScope = RuntimeReload.detectScopeForFile(filePath) ?? "auto"
        const runtimeReload = runtimeReloadTargets.length
          ? await RuntimeReload.reload({
              targets: runtimeReloadTargets,
              scope: runtimeReloadScope,
              reason: `revise_file:${title}`,
            })
          : undefined
        const builtinSourceWarning = RuntimeReload.builtinSourceEditWarning(filePath)
        const newTag = store.record(filePath, newContent)
        let output = formatHashlineBlock(title, newTag, newContent)
        if (runtimeReload) output += `\nRuntime reload applied: ${runtimeReload.executed.join(",")}`
        if (builtinSourceWarning) output += `\n${builtinSourceWarning}`

        return {
          title,
          output,
          metadata: {
            filepath: filePath,
            path: title,
            tag: newTag,
            applied: true,
            operations: patch.ops.length,
            diff,
            runtimeReload,
            builtinSourceWarning,
          },
        }
      },
      { signal: ctx.abort },
    )
  },
})
