import z from "zod"
import { Tool } from "./tool"

const DESCRIPTION = `Render arbitrary HTML content inline in the conversation.

Accepts a complete HTML document or HTML fragment and renders it in a sandboxed iframe. The HTML can contain inline SVG, CSS, and HTML tables — anything that doesn't require JavaScript execution.

Use this to display:
- Rich data visualizations (charts, graphs, diagrams — using inline SVG)
- Comparison tables with custom formatting
- Timelines, trees, and flow charts
- Any structured information that benefits from visual layout

Rendering behavior:
- The renderer injects a polished default theme: dark gradient background, readable system font, table styling, code styling, and sensible spacing
- You may pass a small HTML fragment; you do not need to include <html>, <head>, <body>, or boilerplate styles
- Add your own <style> block when you need custom layout, colors, SVG sizing, or animation
- Use data-render-fullbleed on a single root element when you want to opt out of default body padding
- The iframe uses a strict CSP and no script execution. External network resources are blocked; use inline SVG/CSS and data/blob images only.`

export const RenderTool = Tool.define("render", {
  description: DESCRIPTION,
  parameters: z.object({
    html: z
      .string()
      .describe(
        "HTML fragment or document to render. Can include inline <style>, <svg>, <table>, and other HTML elements. JavaScript and external network resources are not executed or loaded.",
      ),
    title: z.string().optional().describe("Optional title displayed in the tool card header"),
  }),
  async execute(params) {
    return {
      title: params.title ?? "Render",
      output: `Rendered HTML${params.title ? `: ${params.title}` : ""} (${params.html.length} chars)`,
      metadata: {
        render: "html",
        html: params.html,
      },
    }
  },
})
