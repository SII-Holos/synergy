import type { FeishuApiContext } from "./api-context"

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
