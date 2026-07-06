import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Asset } from "@/asset/asset"
import { Identifier } from "@/id/id"
import { CodexProvider } from "@/provider/codex"
import { ScopeContext } from "@/scope/context"
import type { MessageV2 } from "@/session/message-v2"
import { Tool } from "./tool"

const MODEL = "gpt-image-2"
const IMAGE_MIME = "image/png"
const REQUEST_TIMEOUT_MS = 180_000

export const openAIImageGenDisplay = {
  kind: "media-generation",
  toolCard: "hidden",
  media: {
    type: "image",
    aspectRatio: "auto",
    size: "medium",
    actionLabel: "Generating image",
    pendingTitle: "Generating image",
  },
} as const

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
  size: z
    .string()
    .optional()
    .default("auto")
    .refine(isValidImageSize, {
      message:
        'Use "auto" or WIDTHxHEIGHT where both sides are positive multiples of 16, longest side is <= 3840, total pixels are 655360..8294400, and aspect ratio is <= 3:1.',
    })
    .describe('Image size. Defaults to "auto". Custom values must satisfy the gpt-image-2 WIDTHxHEIGHT constraints.'),
  quality: z.enum(["auto", "low", "medium", "high"]).optional().default("auto"),
  background: z.enum(["auto", "opaque"]).optional().default("auto"),
})

type ImageGenerationResponse = {
  created?: unknown
  background?: unknown
  data?: unknown
  output_format?: unknown
  quality?: unknown
  size?: unknown
  usage?: unknown
}

export const OpenAIImageGenTool = Tool.define(
  "openai_image_gen",
  {
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(params, ctx) {
      const outputPath = resolveOutputPath(params.output_path)
      const filename = path.basename(outputPath)
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
            model: MODEL,
            quality: params.quality,
            size: params.size,
          }),
          signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        })
      } catch (error) {
        throw normalizeCodexAuthError(error)
      }

      if (!response.ok) {
        throw await createProviderError(response)
      }

      const payload = (await safeJson(response)) as ImageGenerationResponse
      const b64 = extractImageData(payload)
      const buffer = decodeImageData(b64)
      if (buffer.length === 0) throw new Error("Codex image generation returned an empty image.")

      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await Bun.write(outputPath, buffer)
      await fs.mkdir(Asset.dir(), { recursive: true })
      const assetId = await Asset.write(buffer, IMAGE_MIME, filename)

      const bytes = buffer.length
      const attachments: MessageV2.AttachmentPart[] = [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "attachment",
          mime: IMAGE_MIME,
          filename,
          url: `asset://${assetId}`,
          presentation: { renderer: "image", size: "medium", crop: false },
          model: {
            mode: "provider-file",
            summary: `Generated image saved to ${outputPath}`,
          },
        },
      ]

      return {
        title: filename,
        output: `Generated image saved to ${outputPath} (${formatSize(bytes)}).`,
        metadata: {
          prompt: params.prompt,
          model: MODEL,
          outputPath,
          requested: {
            size: params.size,
            quality: params.quality,
            background: params.background,
          },
          response: {
            created: payload.created,
            size: payload.size,
            quality: payload.quality,
            background: payload.background,
            outputFormat: payload.output_format,
            usage: payload.usage,
          },
          bytes,
          display: openAIImageGenDisplay,
          truncated: false,
        },
        attachments,
      }
    },
  },
  { display: openAIImageGenDisplay },
)

function resolveOutputPath(outputPath: string): string {
  if (path.isAbsolute(outputPath)) return path.resolve(outputPath)
  return path.resolve(ScopeContext.current.directory, outputPath)
}

function isValidImageSize(size: string): boolean {
  if (size === "auto") return true
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) return false
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false
  if (width <= 0 || height <= 0) return false
  if (width % 16 !== 0 || height % 16 !== 0) return false
  if (Math.max(width, height) > 3840) return false
  const pixels = width * height
  if (pixels < 655_360 || pixels > 8_294_400) return false
  return Math.max(width, height) / Math.min(width, height) <= 3
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json()
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function createProviderError(response: Response): Promise<Error> {
  const payload = await safeJson(response)
  const message = providerErrorMessage(payload, `Codex image generation failed with status ${response.status}.`)
  if (response.status === 401 || response.status === 403) {
    return new Error("OpenAI Codex is not connected. Run synergy auth login and choose OpenAI Codex.")
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers)
    return new Error(
      retryAfter
        ? `Codex image generation is rate-limited or quota-limited. Retry after ${retryAfter} seconds.`
        : "Codex image generation is rate-limited or quota-limited.",
    )
  }
  return new Error(`Codex image generation failed with status ${response.status}: ${message}`)
}

function providerErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const nested = error as Record<string, unknown>
    if (typeof nested.message === "string" && nested.message.trim()) return sanitizeProviderMessage(nested.message)
    if (typeof nested.code === "string" && nested.code.trim()) return sanitizeProviderMessage(nested.code)
    if (typeof nested.type === "string" && nested.type.trim()) return sanitizeProviderMessage(nested.type)
  }
  if (typeof error === "string" && error.trim()) return sanitizeProviderMessage(error)
  if (typeof payload.message === "string" && payload.message.trim()) return sanitizeProviderMessage(payload.message)
  if (typeof payload.error_description === "string" && payload.error_description.trim())
    return sanitizeProviderMessage(payload.error_description)
  return fallback
}

function sanitizeProviderMessage(message: string): string {
  const compact = message
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted token]")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "[redacted image data]")
    .replace(/\s+/g, " ")
    .trim()
  if (compact.length <= 500) return compact
  return `${compact.slice(0, 500)}…`
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms")
  if (retryAfterMs) {
    const value = Number(retryAfterMs)
    return Number.isFinite(value) ? Math.ceil(value / 1000) : undefined
  }
  const retryAfter = headers.get("retry-after")
  if (!retryAfter) return undefined
  const value = Number(retryAfter)
  return Number.isFinite(value) ? Math.ceil(value) : undefined
}

function extractImageData(payload: ImageGenerationResponse): string {
  if (!Array.isArray(payload.data)) {
    throw new Error("Codex image generation response did not include image data.")
  }
  const first = payload.data[0]
  if (!first || typeof first !== "object" || typeof (first as { b64_json?: unknown }).b64_json !== "string") {
    throw new Error("Codex image generation response did not include image data.")
  }
  return (first as { b64_json: string }).b64_json
}

function decodeImageData(b64: string): Buffer {
  try {
    const normalized = b64.trim()
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
      throw new Error("invalid base64")
    }
    return Buffer.from(normalized, "base64")
  } catch {
    throw new Error("Codex image generation returned invalid base64 image data.")
  }
}

function normalizeCodexAuthError(error: unknown): Error {
  if (CodexProvider.AuthError.isInstance(error)) {
    return new Error("OpenAI Codex is not connected. Run synergy auth login and choose OpenAI Codex.", { cause: error })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
