import { Log } from "../../../util/log"
import type { FeishuApiContext } from "./api-context"
import { FeishuOutboundMedia } from "./outbound-media"

const log = Log.create({ service: "channel.feishu.markdown-image" })

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g
const IMAGE_KEY_PATTERN = /^img(?:_v?\d+)?_[A-Za-z0-9_-]+$/
const HTTP_URL_PATTERN = /^https?:\/\//i

type ImageReference = { alt: string; destination: string; index: number; length: number }
type NonRenderedSpan = { start: number; end: number }

function isFenceStart(
  text: string,
  index: number,
): { fenceChar: string; fenceLength: number; end: number } | undefined {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1
  if (index - lineStart > 3) return undefined
  const fenceChar = text[index]
  if (fenceChar !== "`" && fenceChar !== "~") return undefined
  let fenceLength = 0
  while (index + fenceLength < text.length && text[index + fenceLength] === fenceChar) fenceLength += 1
  if (fenceLength < 3) return undefined
  const lineEnd = text.indexOf("\n", index + fenceLength)
  const infoLine = lineEnd === -1 ? text.slice(index + fenceLength) : text.slice(index + fenceLength, lineEnd)
  if (fenceChar === "`" && infoLine.includes("`")) return undefined
  return { fenceChar, fenceLength, end: lineEnd === -1 ? text.length : lineEnd + 1 }
}

function collectNonRenderedSpans(text: string): NonRenderedSpan[] {
  const spans: NonRenderedSpan[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === "\\" && i + 1 < text.length) {
      // Escaped punctuation renders literally; skip both characters.
      spans.push({ start: i, end: i + 2 })
      i += 2
      continue
    }
    if (ch === "`" || ch === "~") {
      const fence = isFenceStart(text, i)
      if (fence) {
        let searchFrom = fence.end
        let blockEnd = text.length
        while (searchFrom < text.length) {
          const lineEnd = text.indexOf("\n", searchFrom)
          const line = lineEnd === -1 ? text.slice(searchFrom) : text.slice(searchFrom, lineEnd)
          const trimmed = line.trimStart()
          const closeLength = /^[`~]+/.exec(trimmed)?.[0]?.length ?? 0
          if (closeLength >= fence.fenceLength && trimmed[0] === fence.fenceChar && /^[`~]+\s*$/.test(trimmed)) {
            blockEnd = lineEnd === -1 ? text.length : lineEnd + 1
            break
          }
          if (lineEnd === -1) break
          searchFrom = lineEnd + 1
        }
        spans.push({ start: i, end: blockEnd })
        i = blockEnd
        continue
      }
      // Inline code span: one or more backticks until the same run of backticks.
      let ticks = 0
      while (i + ticks < text.length && text[i + ticks] === "`") ticks += 1
      const close = text.indexOf("`".repeat(ticks), i + ticks)
      if (close !== -1) {
        spans.push({ start: i, end: close + ticks })
        i = close + ticks
        continue
      }
      i += ticks
      continue
    }
    i += 1
  }
  return spans
}

export function collectRenderableImages(text: string): ImageReference[] {
  const nonRendered = collectNonRenderedSpans(text)
  return [...text.matchAll(MARKDOWN_IMAGE_PATTERN)]
    .filter((match) => {
      const index = match.index ?? 0
      return !nonRendered.some((span) => index >= span.start && index < span.end)
    })
    .map((match) => ({
      alt: match[1] ?? "",
      destination: (match[2] ?? "").split(/\s+/)[0] ?? "",
      index: match.index ?? 0,
      length: match[0].length,
    }))
}

function isImageKey(destination: string): boolean {
  return IMAGE_KEY_PATTERN.test(destination)
}

/**
 * Synchronously rewrites renderable image syntax so Feishu never rejects the
 * card: HTTP URLs become plain links, non-HTTP destinations keep only the alt
 * text, and already-valid image keys are preserved. Code contexts are left
 * untouched. Used on the high-frequency streaming render path where network
 * I/O is not acceptable.
 */
export function degradeMarkdownImages(text: string): string {
  const images = collectRenderableImages(text)
  if (images.length === 0) return text

  let result = text
  for (const image of images.sort((a, b) => b.index - a.index)) {
    const replacement = isImageKey(image.destination)
      ? `![${image.alt}](${image.destination})`
      : HTTP_URL_PATTERN.test(image.destination)
        ? `[${image.alt}](${image.destination})`
        : image.alt
    result = result.slice(0, image.index) + replacement + result.slice(image.index + image.length)
  }
  return result
}

export async function materializeMarkdownImages(text: string, ctx: FeishuApiContext): Promise<string> {
  const images = collectRenderableImages(text)
  if (images.length === 0) return text

  const replacements = await Promise.all(
    images.map(async (image) => {
      if (isImageKey(image.destination)) {
        return { index: image.index, length: image.length, to: `![${image.alt}](${image.destination})` }
      }
      if (!HTTP_URL_PATTERN.test(image.destination)) {
        // Non-http destinations (data:, file:, relative) cannot be uploaded;
        // keep only the alt text so the card still renders.
        return { index: image.index, length: image.length, to: image.alt }
      }
      try {
        const { imageKey } = await FeishuOutboundMedia.uploadImageFromUrl(image.destination, ctx)
        return { index: image.index, length: image.length, to: `![${image.alt}](${imageKey})` }
      } catch (error) {
        log.warn("markdown image upload failed; keeping as link", { url: image.destination, error })
        return { index: image.index, length: image.length, to: `[${image.alt}](${image.destination})` }
      }
    }),
  )

  let result = text
  for (const { index, length, to } of replacements.sort((a, b) => b.index - a.index)) {
    result = result.slice(0, index) + to + result.slice(index + length)
  }
  return result
}
