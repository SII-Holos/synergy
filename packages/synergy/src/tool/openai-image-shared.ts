import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Asset } from "@/asset/asset"
import { Identifier } from "@/id/id"
import { CodexProvider } from "@/provider/codex"
import { ScopeContext } from "@/scope/context"
import type { MessageV2 } from "@/session/message-v2"
import type { Tool } from "./tool"

export const OPENAI_IMAGE_MODEL = "gpt-image-2"
export const OPENAI_IMAGE_OUTPUT_MIME = "image/png"
export const OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 180_000

const IMAGE_SIZE_ERROR =
  'Use "auto" or WIDTHxHEIGHT where both sides are positive multiples of 16, longest side is <= 3840, total pixels are 655360..8294400, and aspect ratio is <= 3:1.'

export const openAIImageSizeParameter = z
  .string()
  .optional()
  .default("auto")
  .refine(isValidImageSize, { message: IMAGE_SIZE_ERROR })
  .describe('Image size. Defaults to "auto". Custom values must satisfy the gpt-image-2 WIDTHxHEIGHT constraints.')

export const openAIImageQualityParameter = z.enum(["auto", "low", "medium", "high"]).optional().default("auto")
export const openAIImageBackgroundParameter = z.enum(["auto", "opaque"]).optional().default("auto")

export const openAIImageGenerationDisplay = {
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

export const openAIImageEditDisplay = {
  kind: "media-generation",
  toolCard: "hidden",
  media: {
    type: "image",
    aspectRatio: "auto",
    size: "medium",
    actionLabel: "Editing image",
    pendingTitle: "Editing image",
  },
} as const

export type OpenAIImageResponse = {
  created?: unknown
  background?: unknown
  data?: unknown
  output_format?: unknown
  quality?: unknown
  size?: unknown
  usage?: unknown
}

export type OpenAIImageRequestedOptions = {
  size: string
  quality: "auto" | "low" | "medium" | "high"
  background: "auto" | "opaque"
}

export type OpenAIImageInputInfo = {
  path: string
  mime: string
  bytes: number
}

export type OpenAIImageResultParams = {
  operation: "Generated" | "Edited"
  prompt: string
  outputPath: string
  requested: OpenAIImageRequestedOptions
  payload: OpenAIImageResponse
  buffer: Buffer
  display: typeof openAIImageGenerationDisplay | typeof openAIImageEditDisplay
  ctx: Pick<Tool.Context, "sessionID" | "messageID">
  inputImages?: OpenAIImageInputInfo[]
}

const INPUT_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

export function resolveImagePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath)
  return path.resolve(ScopeContext.current.directory, inputPath)
}

export function isValidImageSize(size: string): boolean {
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

export async function parseImageResponse(
  response: Response,
  operation: "generation" | "edit",
): Promise<OpenAIImageResponse> {
  if (!response.ok) {
    throw await createProviderError(response, operation)
  }
  return (await safeJson(response)) as OpenAIImageResponse
}

export function extractImageData(payload: OpenAIImageResponse, operation: "generation" | "edit"): string {
  if (!Array.isArray(payload.data)) {
    throw new Error(`Codex image ${operation} response did not include image data.`)
  }
  const first = payload.data[0]
  if (!first || typeof first !== "object" || typeof (first as { b64_json?: unknown }).b64_json !== "string") {
    throw new Error(`Codex image ${operation} response did not include image data.`)
  }
  return (first as { b64_json: string }).b64_json
}

export function decodeImageData(b64: string, operation: "generation" | "edit"): Buffer {
  try {
    const normalized = b64.trim()
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
      throw new Error("invalid base64")
    }
    return Buffer.from(normalized, "base64")
  } catch {
    throw new Error(`Codex image ${operation} returned invalid base64 image data.`)
  }
}

export function normalizeCodexAuthError(error: unknown): Error {
  if (CodexProvider.AuthError.isInstance(error)) {
    return new Error("OpenAI Codex is not connected. Run synergy auth login and choose OpenAI Codex.", { cause: error })
  }
  return error instanceof Error ? error : new Error(String(error))
}

export async function readInputImageDataURL(
  inputPath: string,
): Promise<{ image_url: string; info: OpenAIImageInputInfo }> {
  const filepath = resolveImagePath(inputPath)
  const file = Bun.file(filepath)
  if (!(await file.exists())) {
    throw new Error(`Referenced image not found: ${filepath}`)
  }

  const mime = inferInputImageMime(filepath, file.type)
  if (!isSupportedInputImageMime(mime)) {
    throw new Error(`${path.basename(filepath)}: ${mime} is not a supported image input. Use PNG, JPEG, or WebP.`)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  if (!isValidInputImage(buffer, mime)) {
    throw new Error(`${path.basename(filepath)}: file content does not match ${mime}.`)
  }

  return {
    image_url: `data:${mime};base64,${buffer.toString("base64")}`,
    info: { path: filepath, mime, bytes: buffer.length },
  }
}

export async function buildOpenAIImageResult(params: OpenAIImageResultParams) {
  if (params.buffer.length === 0)
    throw new Error(`Codex image ${params.operation.toLowerCase()} returned an empty image.`)

  const filename = path.basename(params.outputPath)
  await fs.mkdir(path.dirname(params.outputPath), { recursive: true })
  await Bun.write(params.outputPath, params.buffer)
  await fs.mkdir(Asset.dir(), { recursive: true })
  const assetId = await Asset.write(params.buffer, OPENAI_IMAGE_OUTPUT_MIME, filename)
  const bytes = params.buffer.length

  const attachments: MessageV2.AttachmentPart[] = [
    {
      id: Identifier.ascending("part"),
      sessionID: params.ctx.sessionID,
      messageID: params.ctx.messageID,
      type: "attachment",
      mime: OPENAI_IMAGE_OUTPUT_MIME,
      filename,
      url: `asset://${assetId}`,
      localPath: params.outputPath,
      presentation: { renderer: "image", size: "medium", crop: false },
      model: {
        mode: "provider-file",
        summary: `${params.operation} image saved to ${params.outputPath}`,
      },
    },
  ]

  return {
    title: filename,
    output: `${params.operation} image saved to ${params.outputPath} (${formatSize(bytes)}).`,
    metadata: {
      prompt: params.prompt,
      model: OPENAI_IMAGE_MODEL,
      outputPath: params.outputPath,
      ...(params.inputImages ? { inputImages: params.inputImages } : {}),
      requested: params.requested,
      response: {
        created: params.payload.created,
        size: params.payload.size,
        quality: params.payload.quality,
        background: params.payload.background,
        outputFormat: params.payload.output_format,
        usage: params.payload.usage,
      },
      bytes,
      display: params.display,
      truncated: false,
    },
    attachments,
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json()
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function createProviderError(response: Response, operation: "generation" | "edit"): Promise<Error> {
  const payload = await safeJson(response)
  const message = providerErrorMessage(payload, `Codex image ${operation} failed with status ${response.status}.`)
  if (response.status === 401 || response.status === 403) {
    return new Error("OpenAI Codex is not connected. Run synergy auth login and choose OpenAI Codex.")
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers)
    return new Error(
      retryAfter
        ? `Codex image ${operation} is rate-limited or quota-limited. Retry after ${retryAfter} seconds.`
        : `Codex image ${operation} is rate-limited or quota-limited.`,
    )
  }
  return new Error(`Codex image ${operation} failed with status ${response.status}: ${message}`)
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
    .replace(/(^|[^A-Za-z0-9+/=])([A-Za-z0-9+/=]{60,})(?=$|[^A-Za-z0-9+/=])/g, "$1[redacted image data]")
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

function inferInputImageMime(filepath: string, fileType: string): string {
  const normalizedFileType = fileType.split(";", 1)[0] || fileType
  if (normalizedFileType.startsWith("image/")) return normalizedFileType
  return (
    INPUT_IMAGE_MIME_BY_EXTENSION[path.extname(filepath).toLowerCase()] ??
    (normalizedFileType || "application/octet-stream")
  )
}

function isSupportedInputImageMime(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp"
}

function isValidInputImage(buffer: Buffer, mime: string): boolean {
  if (mime === "image/png") return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mime === "image/jpeg") return startsWith(buffer, [0xff, 0xd8, 0xff])
  if (mime === "image/webp")
    return (
      startsWith(buffer, [...byteString("RIFF")]) &&
      byteString("WEBP").every((byte, index) => buffer[8 + index] === byte)
    )
  return false
}

function startsWith(buffer: Buffer, prefix: number[]): boolean {
  if (buffer.length < prefix.length) return false
  return prefix.every((byte, index) => buffer[index] === byte)
}

function byteString(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
