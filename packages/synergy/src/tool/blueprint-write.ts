import z from "zod"
import { Tool } from "./tool"
import { NoteError, NoteStore, NoteMarkdown } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./blueprint-write.txt"

const parameters = z.object({
  id: z.string().describe("Blueprint note ID to update."),
  content: z.string().describe("Blueprint content in markdown format."),
  mode: z.enum(["append", "replace"]).describe("'append': add content to end, 'replace': overwrite content."),
  title: z.string().optional().describe("New title for the blueprint."),
  tags: z.array(z.string()).optional().describe("Tags for the blueprint."),
  description: z.string().optional().describe("Short description of what this blueprint does."),
  status: z.enum(["draft", "ready", "archived"]).optional().describe("Blueprint status."),
  defaultAgent: z.string().optional().describe("Default agent for this blueprint."),
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
      `Error: blueprint changed since it was read for ${input.action}.`,
      `ID: ${input.id}`,
      `Expected version: ${input.expectedVersion}`,
      `Current version: ${input.currentVersion}`,
      "Please retry the operation against the latest blueprint content.",
    ].join("\n"),
    metadata: { id: input.id, action: input.action, conflict: true } as Record<string, any>,
  }
}

async function updateExisting(input: {
  id: string
  action: "append" | "replace"
  title?: string
  tags?: string[]
  description?: string
  status?: string
  defaultAgent?: string
  content: unknown
}) {
  const existing = await NoteStore.getAny(Instance.scope.id, input.id)
  const nextTitle = input.title ?? existing.title

  const patch: Record<string, unknown> = {
    content: input.content,
    expectedVersion: existing.version,
  }
  if (input.title !== undefined) patch.title = input.title
  if (input.tags !== undefined) patch.tags = input.tags
  if (input.description !== undefined || input.status !== undefined || input.defaultAgent !== undefined) {
    patch.blueprint = {
      ...(existing.blueprint ?? {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
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

  return {
    title: nextTitle,
    output: [
      `Blueprint updated successfully (${input.action === "append" ? "appended" : "replaced"}).`,
      `ID: ${input.id}`,
      `Title: ${nextTitle}`,
      ...(input.tags ? [`Tags: ${input.tags.join(", ")}`] : []),
    ].join("\n"),
    metadata: { id: input.id, action: input.action, title: nextTitle } as Record<string, any>,
  }
}

export const BlueprintWriteTool = Tool.define("blueprint_write", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const tiptapContent = NoteMarkdown.fromMarkdown(params.content)

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
        description: params.description,
        status: params.status,
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
        description: params.description,
        status: params.status,
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
