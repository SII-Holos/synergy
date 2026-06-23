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
  kind: z
    .enum(["note", "blueprint"])
    .optional()
    .describe("Document kind. Use 'blueprint' when this note should be executable as a BlueprintLoop."),
  description: z.string().optional().describe("Short blueprint description. Only used when kind is 'blueprint'."),
  defaultAgent: z.string().optional().describe("Default agent for this blueprint. Only used when kind is 'blueprint'."),
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
  kind?: "note" | "blueprint"
  description?: string
  defaultAgent?: string
  content: unknown
}) {
  const existing = await NoteStore.getAny(Instance.scope.id, input.id)
  const nextTitle = input.title ?? existing.title
  const nextKind =
    input.kind ?? (input.description !== undefined || input.defaultAgent !== undefined ? "blueprint" : undefined)

  const patch: Record<string, unknown> = {
    title: input.title ?? undefined,
    content: input.content,
    tags: input.tags ?? undefined,
    expectedVersion: existing.version,
  }

  if (nextKind === "note") {
    patch.kind = "note"
    patch.blueprint = null
  } else if (nextKind === "blueprint") {
    patch.kind = "blueprint"
    patch.blueprint = {
      ...(existing.blueprint ?? {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.defaultAgent !== undefined ? { defaultAgent: input.defaultAgent } : {}),
    }
  }

  try {
    await NoteStore.updateAny(Instance.scope.id, input.id, patch as any)
  } catch (error) {
    if (error instanceof NoteError.Conflict) {
      return createConflictResult({
        id: input.id,
        action: input.action,
        title: existing.title,
        expectedVersion: existing.version,
        currentVersion: error instanceof NoteError.Conflict ? error.data.note.version : 0,
      })
    }
    throw error
  }

  const kind = nextKind ?? existing.kind ?? "note"
  const label = kind === "blueprint" ? "Blueprint" : "Note"

  return {
    title: nextTitle,
    output: [
      `${label} updated successfully (${input.action === "append" ? "appended" : "replaced"}).`,
      `ID: ${input.id}`,
      `Title: ${nextTitle}`,
      `Kind: ${kind}`,
      ...(input.tags ? [`Tags: ${input.tags.join(", ")}`] : []),
    ].join("\n"),
    metadata: { id: input.id, action: input.action, title: nextTitle, kind } as Record<string, any>,
  }
}

export const NoteWriteTool = Tool.define("note_write", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const tiptapContent = NoteMarkdown.fromMarkdown(params.content)

    if (params.mode === "create") {
      if (!params.title) {
        return {
          title: "Error",
          output: "Error: title is required when creating a new note.",
          metadata: { action: "create" } as Record<string, any>,
        }
      }

      const scopeID = params.scope === "global" ? "global" : Instance.scope.id
      const kind =
        params.kind ?? (params.description !== undefined || params.defaultAgent !== undefined ? "blueprint" : "note")
      const note = await NoteStore.create(
        {
          title: params.title,
          content: tiptapContent,
          tags: params.tags,
          kind,
          blueprint:
            kind === "blueprint"
              ? {
                  description: params.description,
                  defaultAgent: params.defaultAgent,
                }
              : undefined,
        },
        { scopeID },
      )

      const label = kind === "blueprint" ? "Blueprint" : "Note"
      return {
        title: note.title,
        output: [
          `${label} created successfully.`,
          `ID: ${note.id}`,
          `Title: ${note.title}`,
          `Kind: ${kind}`,
          `Scope: ${scopeID}`,
          ...(note.tags.length > 0 ? [`Tags: ${note.tags.join(", ")}`] : []),
        ].join("\n"),
        metadata: { id: note.id, action: "create", title: note.title, kind } as Record<string, any>,
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
        kind: params.kind,
        description: params.description,
        defaultAgent: params.defaultAgent,
        content: merged,
      })
    }

    if (params.mode === "replace") {
      return updateExisting({
        id: params.id,
        action: "replace",
        title: params.title,
        tags: params.tags,
        kind: params.kind,
        description: params.description,
        defaultAgent: params.defaultAgent,
        content: tiptapContent,
      })
    }

    return {
      title: "Error",
      output: `Error: unknown mode "${params.mode}".`,
      metadata: { action: params.mode } as Record<string, any>,
    }
  },
})
