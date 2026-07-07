import z from "zod"
import { CodexProvider } from "@/provider/codex"
import { Tool } from "./tool"
import {
  buildOpenAIImageResult,
  decodeImageData,
  extractImageData,
  normalizeCodexAuthError,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  openAIImageBackgroundParameter,
  openAIImageGenerationDisplay,
  openAIImageQualityParameter,
  openAIImageSizeParameter,
  parseImageResponse,
  resolveImagePath,
} from "./openai-image-shared"

export const openAIImageGenDisplay = openAIImageGenerationDisplay

const DESCRIPTION = `Generate a new image from a text prompt and save it to output_path.

Use it when the user wants a raster visual such as an illustration, photo, product shot, UI mockup, concept art, texture, sprite, meme, poster, or marketing image.

Do not use it for deterministic diagrams, SVG/icon systems, or code-native visuals better built as HTML/CSS/canvas/vector assets. This tool creates a brand-new image only; it does not edit existing images or use references.

Guidelines:
- Directly generate the image unless the request is missing essential visual requirements or a safe output_path.
- Always set output_path. Prefer a workspace-relative .png path for project assets; use a distinct path for each generated image.
- Write the prompt as the full creative brief: subject, setting, style, composition, camera/framing, lighting, color palette, mood, materials, constraints, and avoidances.
- If text must appear in the image, quote the exact text. If no text is desired, say no text/no watermark.
- Use quality "low" for quick drafts; use "medium", "high", or "auto" for final or detail-sensitive images.
- Use size "auto" by default. Custom size must be WIDTHxHEIGHT within the schema constraints.
- Use background "auto" or "opaque"; transparent background is not supported.
- Do not ask for multiple unrelated images in one call; call once per image with a separate output_path.
- After a successful generation, keep the response brief because the image attachment and saved path are already returned.`

const Parameters = z.object({
  prompt: z.string().min(1).max(12_000).describe("Image generation prompt, 1–12000 characters. Sent as-is."),
  output_path: z
    .string()
    .min(1)
    .describe(
      "Required PNG output path. Relative paths resolve under the current workspace; absolute paths are used as provided.",
    ),
  size: openAIImageSizeParameter,
  quality: openAIImageQualityParameter,
  background: openAIImageBackgroundParameter,
})

export const OpenAIImageGenTool = Tool.define(
  "openai_image_gen",
  {
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(params, ctx) {
      const outputPath = resolveImagePath(params.output_path)
      let response: Response

      try {
        response = await CodexProvider.codexFetch(`${CodexProvider.runtimeBaseURL()}/images/generations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            prompt: params.prompt,
            background: params.background,
            model: OPENAI_IMAGE_MODEL,
            quality: params.quality,
            size: params.size,
          }),
          signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(OPENAI_IMAGE_REQUEST_TIMEOUT_MS)]),
        })
      } catch (error) {
        throw normalizeCodexAuthError(error)
      }

      const payload = await parseImageResponse(response, "generation")
      const buffer = decodeImageData(extractImageData(payload, "generation"), "generation")
      return buildOpenAIImageResult({
        operation: "Generated",
        prompt: params.prompt,
        outputPath,
        requested: { size: params.size, quality: params.quality, background: params.background },
        payload,
        buffer,
        display: openAIImageGenDisplay,
        ctx,
      })
    },
  },
  { display: openAIImageGenDisplay },
)
