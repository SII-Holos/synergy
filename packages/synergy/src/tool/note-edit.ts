import z from "zod"
import { Tool } from "./tool"
import { NoteError, NoteStore, NoteMarkdown, NoteBlueprintPolicy } from "../note"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import DESCRIPTION from "./note-edit.txt"
import { Session } from "../session"

const parameters = z.object({
  id: z.string().describe("The note ID to edit."),
  ops: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .describe("Block index (0-based), referencing blocks from note_read format:'blocks' output."),
        action: z
          .enum(["replace", "insertAfter", "delete"])
          .describe(
            "replace: overwrite block at index. insertAfter: insert new blocks after index. delete: remove block at index.",
          ),
        content: z
          .string()
          .optional()
          .describe("Markdown content. Required for replace and insertAfter. Not used for delete."),
      }),
    )
    .describe(
      "Ordered list of block operations. Operations are applied in descending index order to avoid index shifts.",
    ),
})

function sortDescending<T extends { index: number }>(ops: T[]): T[] {
  return [...ops].sort((a, b) => b.index - a.index)
}

export const NoteEditTool = Tool.define("note_edit", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    if (params.ops.length === 0) {
      return {
        title: "Error",
        output: "Error: at least one operation is required.",
        metadata: { id: params.id } as Record<string, any>,
      }
    }

    for (const op of params.ops) {
      if (op.action !== "delete" && !op.content) {
        return {
          title: "Error",
          output: `Error: "${op.action}" operation at index ${op.index} requires content.`,
          metadata: { id: params.id } as Record<string, any>,
        }
      }
    }

    let existing: Awaited<ReturnType<typeof NoteStore.getAny>>
    try {
      existing = await NoteStore.getAny(ScopeContext.current.scope.id, params.id)
    } catch (error) {
      if (error instanceof Storage.NotFoundError) {
        return {
          title: "Error",
          output: `Error: note "${params.id}" not found. It may have been deleted or never existed.`,
          metadata: { id: params.id, notFound: true } as Record<string, any>,
        }
      }
      throw error
    }

    const session = await Session.get(ctx.sessionID)
    const decision = NoteBlueprintPolicy.evaluateWrite({
      planMode: session.blueprint?.planMode === true,
      action: "edit",
      existingKind: existing.kind ?? "note",
    })
    if (!decision.allowed) {
      return NoteBlueprintPolicy.blockedResult({ action: decision.action, id: params.id, title: existing.title })
    }

    const doc =
      existing.content && typeof existing.content === "object" && Array.isArray(existing.content.content)
        ? { ...existing.content, content: [...existing.content.content] }
        : { type: "doc", content: [] }

    const sorted = sortDescending(params.ops)

    for (const op of sorted) {
      const maxIndex = doc.content.length - 1
      if (op.index < 0 || op.index > maxIndex) {
        return {
          title: "Error",
          output: `Error: block index ${op.index} is out of bounds. Valid range for "${op.action}" is 0-${maxIndex} (doc has ${doc.content.length} blocks).`,
          metadata: { id: params.id } as Record<string, any>,
        }
      }

      switch (op.action) {
        case "delete":
          doc.content.splice(op.index, 1)
          break
        case "replace": {
          const parsed = NoteMarkdown.fromMarkdown(op.content!)
          const parsedBlocks = parsed.content ?? []
          doc.content.splice(op.index, 1, ...parsedBlocks)
          break
        }
        case "insertAfter": {
          const parsed = NoteMarkdown.fromMarkdown(op.content!)
          const parsedBlocks = parsed.content ?? []
          doc.content.splice(op.index + 1, 0, ...parsedBlocks)
          break
        }
      }
    }

    if (sorted.length === 0) {
      return {
        title: existing.title,
        output: ["Note unchanged.", `ID: ${params.id}`, "No changes were applied."].join("\n"),
        metadata: { id: params.id, noop: true } as Record<string, any>,
      }
    }

    try {
      await NoteStore.updateAny(ScopeContext.current.scope.id, params.id, {
        content: doc,
        expectedVersion: existing.version,
      })
    } catch (error) {
      if (error instanceof NoteError.Conflict) {
        return {
          title: "Conflict",
          output: [
            "Error: note changed since it was last read.",
            `ID: ${params.id}`,
            `Expected version: ${existing.version}`,
            `Current version: ${error.data.note.version}`,
            "Please re-read the note and retry the edit.",
          ].join("\n"),
          metadata: { id: params.id, conflict: true } as Record<string, any>,
        }
      }
      if (error instanceof Storage.NotFoundError) {
        return {
          title: "Error",
          output: `Error: note "${params.id}" was deleted while the edit was in progress.`,
          metadata: { id: params.id, deleted: true } as Record<string, any>,
        }
      }
      throw error
    }

    return {
      title: existing.title,
      output: [
        "Note edited successfully.",
        `ID: ${params.id}`,
        `Title: ${existing.title}`,
        `Operations applied: ${sorted.length}`,
      ].join("\n"),
      metadata: { id: params.id, title: existing.title, opCount: sorted.length },
    }
  },
})
