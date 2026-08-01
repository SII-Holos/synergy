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

async function materializeMarkdownImages(text: string, ctx: FeishuApiContext): Promise<string> {
  const images = [...text.matchAll(MARKDOWN_IMAGE_PATTERN)]
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
