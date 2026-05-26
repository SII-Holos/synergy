import z from "zod"
import { Tool } from "./tool"
import { NoteError, NoteStore, NoteMarkdown } from "../note"
import { Instance } from "../scope/instance"
import { Storage } from "../storage/storage"
import { replace } from "./edit"
import DESCRIPTION from "./note-edit.txt"

const parameters = z.object({
  id: z.string().describe("The note ID to edit."),
  oldString: z.string().describe("The exact text to find and replace in the note's markdown content."),
  newString: z.string().describe("The text to replace oldString with (must be different from oldString)."),
  replaceAll: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, replace ALL occurrences of oldString instead of failing when multiple matches exist."),
})

function conflictResult(noteID: string, expectedVersion: number, currentVersion: number) {
  return {
    title: "Conflict",
    output: [
      `Error: note changed since it was last read.`,
      `ID: ${noteID}`,
      `Expected version: ${expectedVersion}`,
      `Current version: ${currentVersion}`,
      `Please re-read the note and retry the edit.`,
    ].join("\n"),
    metadata: { id: noteID, conflict: true } as Record<string, any>,
  }
}

export const NoteEditTool = Tool.define("note_edit", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    if (params.oldString === params.newString) {
      return {
        title: "Error",
        output: "Error: oldString and newString are identical — nothing to change.",
        metadata: { id: params.id } as Record<string, any>,
      }
    }

    if (params.oldString.length === 0) {
      return {
        title: "Error",
        output: "Error: oldString cannot be empty. Use note_write (append or replace mode) to add new content.",
        metadata: { id: params.id } as Record<string, any>,
      }
    }

    // Read current note state — catch NotFoundError for bad IDs
    let existing: Awaited<ReturnType<typeof NoteStore.getAny>>
    try {
      existing = await NoteStore.getAny(Instance.scope.id, params.id)
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

    const sourceText = existing.contentText

    // Use edit.ts's battle-tested replace() — runs the full 9-Replacer chain
    // (SimpleReplacer → LineTrimmedReplacer → BlockAnchorReplacer → … → MultiOccurrenceReplacer),
    // with intelligent error messages (similar-lines hints, match locations).
    let newText: string
    try {
      newText = replace(sourceText, params.oldString, params.newString, params.replaceAll)
    } catch (error) {
      return {
        title: existing.title,
        output: error instanceof Error ? error.message : String(error),
        metadata: { id: params.id, replaceError: true } as Record<string, any>,
      }
    }

    // Guard against no-op writes: if replace() returned unchanged content
    // (e.g. oldString matched nothing, or whitespace-only delta), skip the write.
    if (newText === sourceText) {
      return {
        title: existing.title,
        output: [
          `Note unchanged.`,
          `ID: ${params.id}`,
          `The replacement produced no changes — the note content is already as requested.`,
        ].join("\n"),
        metadata: { id: params.id, noop: true } as Record<string, any>,
      }
    }

    // Convert markdown back to TipTap JSON
    // Note: this round-trip only preserves markdown-representable content.
    // Rich TipTap nodes (mentions, text colors, custom extensions) that were
    // rendered lossily in contentText will be stripped from the structured content.
    const tiptapContent = NoteMarkdown.fromMarkdown(newText)

    // Write with optimistic concurrency
    try {
      await NoteStore.updateAny(Instance.scope.id, params.id, {
        title: existing.title,
        content: tiptapContent,
        contentText: newText,
        expectedVersion: existing.version,
      })
    } catch (error) {
      if (error instanceof NoteError.Conflict) {
        return conflictResult(params.id, existing.version, error.data.note.version)
      }
      // Catch note-deleted-during-edit race
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
      output: [`Note edited successfully.`, `ID: ${params.id}`, `Title: ${existing.title}`].join("\n"),
      metadata: { id: params.id, title: existing.title } as Record<string, any>,
    }
  },
})
