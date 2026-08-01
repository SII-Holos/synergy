import { Log } from "../../../util/log"
import type { FeishuApiContext } from "./api-context"
import { FeishuOutboundMedia } from "./outbound-media"

const log = Log.create({ service: "channel.feishu.send-card" })

const REQUEST_TIMEOUT_MS = 15_000

export async function sendFeishuCard(
  input: FeishuApiContext & {
    cardJson: unknown
    chatId: string
    replyToMessageId?: string
    replyInThread?: boolean
    kind: string
  },
): Promise<{ messageId: string }> {
  const token = await input.getAccessToken()
  const createResponse = await fetch(`${input.apiBase}/cardkit/v1/cards`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "card_json", data: JSON.stringify(input.cardJson) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const createResult = (await createResponse.json()) as {
    code?: number
    msg?: string
    data?: { card_id?: string }
  }
  if (!createResponse.ok || createResult.code !== 0) {
    throw new Error(
      `Failed to create ${input.kind}: ${createResult.msg ?? `code ${createResult.code ?? createResponse.status}`}`,
    )
  }
  const cardId = createResult.data?.card_id
  if (!cardId) throw new Error(`Failed to create ${input.kind}: no card_id returned`)

  const content = JSON.stringify({ type: "card", data: { card_id: cardId } })
  const response = input.replyToMessageId
    ? await fetch(`${input.apiBase}/im/v1/messages/${input.replyToMessageId}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          msg_type: "interactive",
          ...(input.replyInThread ? { reply_in_thread: true } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    : await fetch(`${input.apiBase}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ receive_id: input.chatId, content, msg_type: "interactive" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
  const result = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
  if (!response.ok || result.code !== 0) {
    throw new Error(`Failed to send ${input.kind}: ${result.msg ?? `code ${result.code ?? response.status}`}`)
  }
  const messageId = result.data?.message_id
  if (!messageId) throw new Error(`Failed to send ${input.kind}: no message_id returned`)
  return { messageId }
}

const MAX_MARKDOWN_CARD_BYTES = 30 * 1024
const BLANK_MARKDOWN = " "

function normalizeMarkdown(content: string): string {
  return content.trim() ? content : BLANK_MARKDOWN
}

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g

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

async function materializeMarkdownImages(text: string, ctx: FeishuApiContext): Promise<string> {
  const nonRendered = collectNonRenderedSpans(text)
  const images = [...text.matchAll(MARKDOWN_IMAGE_PATTERN)].filter(
    (match) => !nonRendered.some((span) => (match.index ?? 0) >= span.start && (match.index ?? 0) < span.end),
  )
  if (images.length === 0) return text

  const replacements = await Promise.all(
    images.map(async (match) => {
      const alt = match[1] ?? ""
      const destination = (match[2] ?? "").split(/\s+/)[0] ?? ""
      if (!/^https?:\/\//i.test(destination)) {
        // Non-http destinations (data:, file:, relative) cannot be uploaded;
        // keep only the alt text so the card still renders.
        return { index: match.index ?? 0, length: match[0].length, to: alt }
      }
      try {
        const { imageKey } = await FeishuOutboundMedia.uploadImageFromUrl(destination, ctx)
        return { index: match.index ?? 0, length: match[0].length, to: `![${alt}](${imageKey})` }
      } catch (error) {
        log.warn("markdown image upload failed; keeping as link", { url: destination, error })
        return { index: match.index ?? 0, length: match[0].length, to: `[${alt}](${destination})` }
      }
    }),
  )

  replacements.sort((a, b) => b.index - a.index)
  let result = text
  for (const { index, length, to } of replacements) {
    result = result.slice(0, index) + to + result.slice(index + length)
  }
  return result
}

export function buildFeishuMarkdownCard(text: string): Record<string, unknown> | undefined {
  const cardJson = {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [{ tag: "markdown", content: normalizeMarkdown(text) }],
    },
  }
  if (Buffer.byteLength(JSON.stringify(cardJson), "utf8") > MAX_MARKDOWN_CARD_BYTES) return undefined
  return cardJson
}

export async function sendFeishuMarkdownCard(
  input: FeishuApiContext & {
    text: string
    chatId: string
    replyToMessageId?: string
    replyInThread?: boolean
  },
): Promise<{ messageId: string } | undefined> {
  const text = await materializeMarkdownImages(input.text, input)
  const cardJson = buildFeishuMarkdownCard(text)
  if (!cardJson) return undefined
  return sendFeishuCard({ ...input, cardJson, kind: "markdown reply" })
}

export function sanitizeFeishuCardMarkdown(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|file|data):\/\/\S+/gi, "")
    .trim()
}

export function normalizeFeishuCallbackString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized || undefined
}
