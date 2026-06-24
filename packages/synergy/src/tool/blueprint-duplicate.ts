import z from "zod"
import { Tool } from "./tool"
import { NoteStore } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./blueprint-duplicate.txt"

const parameters = z.object({
  id: z.string().describe("Blueprint note ID to duplicate."),
  newTitle: z
    .string()
    .optional()
    .describe("Title for the new blueprint. Defaults to original title with '(Copy)' suffix."),
})

export const BlueprintDuplicateTool = Tool.define("blueprint_duplicate", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const original = await NoteStore.getAny(Instance.scope.id, params.id)
    const newTitle = params.newTitle ?? `${original.title} (Copy)`

    const scopeID = original.global ? "global" : Instance.scope.id

    const duplicate = await NoteStore.create(
      {
        title: newTitle,
        content: original.content,
        tags: original.tags,
        kind: "blueprint",
        blueprint: original.blueprint ?? {},
      },
      { scopeID },
    )

    return {
      title: newTitle,
      output: [
        "Blueprint duplicated successfully.",
        `Original ID: ${original.id}`,
        `New ID: ${duplicate.id}`,
        `Title: ${duplicate.title}`,
        `Scope: ${scopeID}`,
      ].join("\n"),
      metadata: {
        action: "duplicate",
        originalId: original.id,
        newId: duplicate.id,
        title: duplicate.title,
      } as Record<string, any>,
    }
  },
})
