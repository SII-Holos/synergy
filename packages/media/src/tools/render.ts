import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { Render } from "../render"
import DESCRIPTION from "./render.txt" with { type: "text" }

export const RenderTool = Tool.define("render", {
  description: DESCRIPTION,
  parameters: z.object({
    html: RenderArtifact.Source.shape.html.describe(
      "Complete HTML fragment with inline CSS, SVG and optional JavaScript. Execute only after the call completes.",
    ),
    artifactTitle: z.string().trim().min(1).max(160).optional().describe("Short name for the visual result"),
    layout: z.enum(["normal", "wide"]).optional(),
    libraries: z
      .array(RenderArtifact.Library)
      .max(3)
      .refine((items) => new Set(items).size === items.length, "Libraries must be unique")
      .optional(),
    replaces: RenderArtifact.ID.optional().describe(
      "ID of a previous visual in this session; creates an immutable new version",
    ),
  }),
  async execute(params, ctx) {
    ctx.abort.throwIfAborted()
    if (params.replaces) await Render.assertVersion(ctx.sessionID, params.replaces)
    const source = RenderArtifact.Source.parse({
      format: "synergy.visual",
      version: 1,
      mode: "interactive",
      id: crypto.randomUUID(),
      title: params.artifactTitle ?? "Visual result",
      layout: params.layout ?? "normal",
      libraries: params.libraries ?? [],
      html: params.html,
      replaces: params.replaces,
    })
    const asset = await Asset.write(Buffer.from(JSON.stringify(source)), RenderArtifact.MIME)
    const { html: _, ...identity } = source
    const descriptor: RenderArtifact.Descriptor = { ...identity, source: `asset://${asset}` }
    return {
      title: source.title,
      output: `Saved visual ${source.id}: ${source.title}. JSON source: ${descriptor.source}. The host displays the visual card. Do not embed this JSON source as an image. Frontend rendering has not been verified.`,
      metadata: { visual: descriptor },
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "attachment" as const,
          mime: RenderArtifact.MIME,
          filename: "visual.synergy.json",
          url: descriptor.source,
          model: { mode: "none" as const },
          presentation: { purpose: "deliverable" as const, renderer: "file" as const },
        },
      ],
    }
  },
})
