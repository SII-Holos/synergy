import z from "zod"
import { Tool } from "./tool"
import { NoteError, NoteStore, NoteMarkdown } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./note-write.txt"

const parameters = z.object({
  id: z.string().optional().describe("Note ID to update. If omitted, creates a new note."),
  title: z.string().optional().describe("Note title. Required when creating a new note."),
  content: z.string().describe("Note content in markdown format."),
  mode: z
    .enum(["create", "append", "replace"])
    .default("create")
    .describe("'create': new note, 'append': add content to end of existing note, 'replace': overwrite content."),
  tags: z.array(z.string()).optional().describe("Tags for the note."),
  scope: z
    .enum(["current", "global"])
    .default("current")
    .describe("Which scope to create the note in. Only used for create mode."),
})

function createConflictResult(input: {
  id: string
  action: "append" | "replace"
  title: string
  expectedVersion: number
  currentVersion: number
}) {
  return {
    title: input.title,
    output: [
      `Error: note changed since it was read for ${input.action}.`,
      `ID: ${input.id}`,
      `Expected version: ${input.expectedVersion}`,
      `Current version: ${input.currentVersion}`,
      "Please retry the operation against the latest note content.",
    ].join("\n"),
    metadata: { id: input.id, action: input.action, conflict: true } as Record<string, any>,
  }
}

async function updateExisting(input: {
  id: string
  action: "append" | "replace"
  title?: string
  tags?: string[]
  content: unknown
  contentText: string
}) {
  const existing = await NoteStore.getAny(Instance.scope.id, input.id)
  const nextTitle = input.title ?? existing.title

  try {
    await NoteStore.updateAny(Instance.scope.id, input.id, {
      title: input.title ?? undefined,
      content: input.content,
      contentText: input.contentText,
      tags: input.tags ?? undefined,
      expectedVersion: existing.version,
    })
  } catch (error) {
    if (error instanceof NoteError.Conflict) {
      return createConflictResult({
        id: input.id,
        action: input.action,
        title: existing.title,
        expectedVersion: existing.version,
        currentVersion: error.data.note.version,
      })
    }
    throw error
  }

  return {
    title: nextTitle,
    output: [
      `Note updated successfully (${input.action === "append" ? "appended" : "replaced"}).`,
      `ID: ${input.id}`,
      `Title: ${nextTitle}`,
      ...(input.tags ? [`Tags: ${input.tags.join(", ")}`] : []),
    ].join("\n"),
    metadata: { id: input.id, action: input.action, title: nextTitle } as Record<string, any>,
  }
}

export const NoteWriteTool = Tool.define("note_write", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const tiptapContent = NoteMarkdown.fromMarkdown(params.content)
    const contentText = params.content

    if (params.mode === "create") {
      if (!params.title) {
        return {
          title: "Error",
          output: "Error: title is required when creating a new note.",
          metadata: { action: "create" } as Record<string, any>,
        }
      }

      const scopeID = params.scope === "global" ? "global" : Instance.scope.id
      const note = await NoteStore.create(
        {
          title: params.title,
          content: tiptapContent,
          contentText,
          tags: params.tags,
        },
        { scopeID },
      )

      return {
        title: note.title,
        output: [
          "Note created successfully.",
          `ID: ${note.id}`,
          `Title: ${note.title}`,
          `Scope: ${scopeID}`,
          ...(note.tags.length > 0 ? [`Tags: ${note.tags.join(", ")}`] : []),
        ].join("\n"),
        metadata: { id: note.id, action: "create", title: note.title } as Record<string, any>,
      }
    }

    if (!params.id) {
      return {
        title: "Error",
        output: "Error: id is required when using append or replace mode.",
        metadata: { action: params.mode } as Record<string, any>,
      }
    }

    if (params.mode === "append") {
      const existing = await NoteStore.getAny(Instance.scope.id, params.id)
      const merged = {
        type: "doc" as const,
        content: [...(existing.content?.content ?? []), ...(tiptapContent.content ?? [])],
      }
      return updateExisting({
        id: params.id,
        action: "append",
        title: params.title,
        tags: params.tags,
        content: merged,
        contentText: existing.contentText + "\n" + contentText,
      })
    }

    if (params.mode === "replace") {
      return updateExisting({
        id: params.id,
        action: "replace",
        title: params.title,
        tags: params.tags,
        content: tiptapContent,
        contentText,
      })
    }

    return {
      title: "Error",
      output: `Error: unknown mode "${params.mode}".`,
      metadata: { action: params.mode } as Record<string, any>,
    }
  },
})
