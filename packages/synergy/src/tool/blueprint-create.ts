import z from "zod"
import { Tool } from "./tool"
import { NoteStore, NoteMarkdown } from "../note"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./blueprint-create.txt"

const parameters = z.object({
  title: z.string().describe("Blueprint title."),
  content: z.string().describe("Blueprint content in markdown format."),
  tags: z.array(z.string()).optional().describe("Tags for the blueprint."),
  description: z.string().optional().describe("Short description of what this blueprint does."),
  status: z
    .enum(["draft", "ready", "archived"])
    .default("draft")
    .describe("Blueprint status: 'draft', 'ready', or 'archived'."),
  defaultAgent: z.string().optional().describe("Default agent for this blueprint."),
  scope: z
    .enum(["current", "global"])
    .default("current")
    .describe("Which scope to create the blueprint in: 'current' or 'global'."),
})

export const BlueprintCreateTool = Tool.define("blueprint_create", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const tiptapContent = NoteMarkdown.fromMarkdown(params.content)
    const scopeID = params.scope === "global" ? "global" : Instance.scope.id

    const note = await NoteStore.create(
      {
        title: params.title,
        content: tiptapContent,
        tags: params.tags,
        kind: "blueprint",
        blueprint: {
          description: params.description,
          status: params.status,
          defaultAgent: params.defaultAgent,
        },
      },
      { scopeID },
    )

    return {
      title: note.title,
      output: [
        "Blueprint created successfully.",
        `ID: ${note.id}`,
        `Title: ${note.title}`,
        `Status: ${note.blueprint?.status ?? "draft"}`,
        `Scope: ${scopeID}`,
        ...(note.tags.length > 0 ? [`Tags: ${note.tags.join(", ")}`] : []),
      ].join("\n"),
      metadata: {
        id: note.id,
        action: "create",
        title: note.title,
        kind: "blueprint",
        status: note.blueprint?.status,
      } as Record<string, any>,
    }
  },
})
