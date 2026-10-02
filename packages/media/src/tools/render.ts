import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"

const DESCRIPTION = `Create a read-only visual result from an HTML fragment or document. Use for charts, diagrams, comparisons and other results that benefit from visual layout. Include HTML, inline CSS and SVG; omit JavaScript and external resources. Small fragments are sufficient. Use data-render-fullbleed on a single root element to remove outer padding. Returns the rendered content and its artifact title.`

export const RenderTool = Tool.define("render", {
  description: DESCRIPTION,
  parameters: z.object({
    html: z
      .string()
      .describe(
        "HTML fragment or document to render. Can include inline <style>, <svg>, <table>, and other HTML elements. JavaScript and external network resources are not executed or loaded.",
      ),
    artifactTitle: z.string().optional().describe("Short name for the visual result; omit to use the default name"),
  }),
  async execute(params) {
    return {
      title: params.artifactTitle ?? "Render",
      output: `Rendered HTML${params.artifactTitle ? `: ${params.artifactTitle}` : ""} (${params.html.length} chars)`,
      metadata: {
        render: "html",
        html: params.html,
      },
    }
  },
})
