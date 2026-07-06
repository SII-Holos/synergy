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
  openAIImageEditDisplay,
  openAIImageQualityParameter,
  openAIImageSizeParameter,
  parseImageResponse,
  readInputImageDataURL,
  resolveImagePath,
} from "./openai-image-shared"

const MAX_INPUT_IMAGES = 5

const DESCRIPTION = `Edit or transform existing images with a text prompt and save the result to output_path.

Use it when the user wants to modify, restyle, composite, expand, clean up, or create a variation from one or more existing raster images.

Do not use it for pure text-to-image generation; use openai_image_gen when there are no input images. Do not use it for deterministic diagrams, SVG/icon systems, or code-native visuals better built as HTML/CSS/canvas/vector assets.

Guidelines:
- Provide 1–5 input_paths. Prefer workspace-relative paths. Each path should point to a PNG, JPEG, or WebP image.
- Always set output_path. Prefer a workspace-relative .png path and keep it distinct from the input images unless the user explicitly wants to overwrite.
- Write the prompt as an edit brief: what to preserve, what to change, style, composition, colors, lighting, exact text if needed, and avoidances.
- If text must appear in the image, quote the exact text. If no text is desired, say no text/no watermark.
- Use quality "low" for quick drafts; use "medium", "high", or "auto" for final or detail-sensitive edits.
- Use size "auto" by default. Custom size must be WIDTHxHEIGHT within the schema constraints.
- Use background "auto" or "opaque"; transparent background is not supported.
- Call once per edited output. For multiple variants, use separate output_path values.
- After a successful edit, keep the response brief because the image attachment and saved path are already returned.`

const Parameters = z.object({
  prompt: z.string().min(1).max(12_000).describe("Image edit prompt, 1–12000 characters. Sent as-is."),
  input_paths: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_INPUT_IMAGES)
    .describe(
      "Required source image paths, 1–5 PNG/JPEG/WebP files. Relative paths resolve under the current workspace.",
    ),
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

export const OpenAIImageEditTool = Tool.define(
  "openai_image_edit",
  {
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(params, ctx) {
      const outputPath = resolveImagePath(params.output_path)
      const inputImages = await Promise.all(params.input_paths.map((inputPath) => readInputImageDataURL(inputPath)))
      let response: Response

      try {
        response = await CodexProvider.codexFetch(`${CodexProvider.runtimeBaseURL()}/images/edits`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            images: inputImages.map(({ image_url }) => ({ image_url })),
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

      const payload = await parseImageResponse(response, "edit")
      const buffer = decodeImageData(extractImageData(payload, "edit"), "edit")
      return buildOpenAIImageResult({
        operation: "Edited",
        prompt: params.prompt,
        outputPath,
        inputImages: inputImages.map(({ info }) => info),
        requested: { size: params.size, quality: params.quality, background: params.background },
        payload,
        buffer,
        display: openAIImageEditDisplay,
        ctx,
      })
    },
  },
  { display: openAIImageEditDisplay },
)
