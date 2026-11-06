import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { NoteError, NoteStore, NoteMarkdown, NoteDocumentKinds } from ".."
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import DESCRIPTION from "./note-write.txt"
import { noteReferenceLine } from "./note-reference"

const parameters = NoteDocumentKinds.toolSchema(
  z.object({
    noteId: z.string().optional().describe("Note ID to update. If omitted, creates a new note."),
    noteTitle: z.string().optional().describe("Note title. Required when creating a new note."),
    noteContent: z.string().describe("Note content in markdown format."),
    mode: z
      .enum(["create", "append", "replace"])
      .default("create")
      .describe("'create': new note, 'append': add content to end of existing note, 'replace': overwrite content."),
    tags: z.array(z.string()).optional().describe("Tags for the note."),
    kind: z.string().optional().describe("Registered document kind."),
    scope: z
      .enum(["current", "home"])
      .default("current")
      .describe("Which scope to create the note in. Only used for create mode."),
  }),
)

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
      `noteId: ${input.id}`,
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
  fields: NoteDocumentKinds.Document
  content(existing: Awaited<ReturnType<typeof NoteStore.getAny>>): unknown
  ctx: Tool.Context
  optimistic?: boolean
}) {
  const existing = await NoteStore.getAny(ScopeContext.current.scope.id, input.id)
  const nextTitle = input.title ?? existing.title
  const nextKind = input.fields.kind
  const blocked = await NoteDocumentKinds.guard({
    sessionID: input.ctx.sessionID,
    action: "update",
    existing,
    requestedKind: nextKind,
    title: nextTitle,
  })
  if (blocked) return blocked

  const patch = {
    ...input.fields,
    title: input.title ?? undefined,
    content: input.content(existing),
    tags: input.tags ?? undefined,
    ...(input.optimistic === false ? {} : { expectedVersion: existing.version }),
  }

  try {
    await NoteStore.updateAny(ScopeContext.current.scope.id, input.id, patch)
  } catch (error) {
    if (NoteError.Conflict.isInstance(error)) {
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

  const kind = nextKind ?? existing.kind ?? "note"
  const label = NoteDocumentKinds.title(kind)

  return {
    title: nextTitle,
    output: [
      `${label} updated successfully (${input.action === "append" ? "appended" : "replaced"}).`,
      `noteId: ${input.id}`,
      `noteTitle: ${nextTitle}`,
      noteReferenceLine(input.id, nextTitle),
      `Kind: ${kind}`,
      ...(input.tags ? [`Tags: ${input.tags.join(", ")}`] : []),
    ].join("\n"),
    metadata: {
      id: input.id,
      action: input.action,
      title: nextTitle,
      kind,
      ...NoteDocumentKinds.metadata(existing),
    } as Record<string, any>,
  }
}

export const NoteWriteTool = Tool.define(
  "note_write",
  async () => ({
    description: NoteDocumentKinds.toolDescription(DESCRIPTION),
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const tiptapContent = NoteMarkdown.fromMarkdown(params.noteContent)

      if (params.mode === "create") {
        if (!params.noteTitle) {
          return {
            title: "Error",
            output: "Error: noteTitle is required when creating a new note.",
            metadata: { action: "create" } as Record<string, any>,
          }
        }

        const scopeID = params.scope === "home" ? "home" : ScopeContext.current.scope.id
        const fields = NoteDocumentKinds.toolInput(params)
        const kind = fields.kind ?? "note"
        const blocked = await NoteDocumentKinds.guard({
          sessionID: ctx.sessionID,
          action: "create",
          requestedKind: kind,
          title: params.noteTitle,
        })
        if (blocked) return blocked
        const note = await NoteStore.create(
          {
            ...fields,
            title: params.noteTitle,
            content: tiptapContent,
            tags: params.tags,
            kind,
          },
          { scopeID },
        )

        const label = NoteDocumentKinds.title(kind)
        return {
          title: note.title,
          output: [
            `${label} created successfully.`,
            `noteId: ${note.id}`,
            `noteTitle: ${note.title}`,
            noteReferenceLine(note.id, note.title),
            `Kind: ${kind}`,
            `Scope: ${scopeID}`,
            ...(note.tags.length > 0 ? [`Tags: ${note.tags.join(", ")}`] : []),
          ].join("\n"),
          metadata: {
            id: note.id,
            action: "create",
            title: note.title,
            kind,
            scopeID,
            ...NoteDocumentKinds.metadata(note),
          } as Record<string, any>,
        }
      }

      if (!params.noteId) {
        return {
          title: "Error",
          output: "Error: noteId is required when using append or replace mode.",
          metadata: { action: params.mode } as Record<string, any>,
        }
      }

      if (params.mode === "append") {
        return updateExisting({
          id: params.noteId,
          action: "append",
          title: params.noteTitle,
          tags: params.tags,
          fields: NoteDocumentKinds.toolInput(params),
          content: (existing) => ({
            type: "doc" as const,
            content: [...(existing.content?.content ?? []), ...(tiptapContent.content ?? [])],
          }),
          ctx,
        })
      }

      if (params.mode === "replace") {
        return updateExisting({
          id: params.noteId,
          action: "replace",
          title: params.noteTitle,
          tags: params.tags,
          fields: NoteDocumentKinds.toolInput(params),
          content: () => tiptapContent,
          ctx,
          optimistic: false,
        })
      }

      return {
        title: "Error",
        output: `Error: unknown mode "${params.mode}".`,
        metadata: { action: params.mode } as Record<string, any>,
      }
    },
  }),
  { activityKind: "object" },
)
