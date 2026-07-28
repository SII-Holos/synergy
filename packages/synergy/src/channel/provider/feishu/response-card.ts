import z from "zod"
import { sha256Content } from "@/util/crypto"
import { ResponseCardCallback, type ResponseCard } from "../../types"
import type { FeishuApiContext } from "./api-context"

const ACTION_PREFIX = "response_card:"
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_CARD_BYTES = 30 * 1024
const RESPONSE_CARD_SIZE_RESERVE_BYTES = 2 * 1024

const CallbackEnvelope = z
  .object({
    version: z.literal(1),
    request_id: z.string().min(1).max(200),
    action_id: z.string().startsWith(ACTION_PREFIX).max(114),
    action_type: z.enum(["button", "select"]),
    value: z.string().min(1).max(100).optional(),
  })
  .strict()

const CallbackPayload = z
  .object({
    header: z.object({ event_id: z.string().optional() }).passthrough().optional(),
    event: z.unknown().optional(),
    event_id: z.string().optional(),
    token: z.string().optional(),
    context: z
      .object({ open_message_id: z.string().optional(), open_chat_id: z.string().optional() })
      .passthrough()
      .optional(),
    open_message_id: z.string().optional(),
    open_chat_id: z.string().optional(),
    operator: z.object({ open_id: z.string().optional() }).passthrough().optional(),
    action: z
      .object({
        tag: z.string().optional(),
        value: z.unknown().optional(),
        option: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

type CallbackPayload = z.infer<typeof CallbackPayload>

type CardJson = {
  schema: "2.0"
  config: { update_multi: true; summary: { content: string } }
  header: { title: { tag: "plain_text"; content: string }; template: "blue" }
  body: { elements: unknown[] }
}

export function renderFeishuResponseCard(card: ResponseCard, requestId = "request"): CardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: card.title } },
    header: { title: { tag: "plain_text", content: card.title }, template: "blue" },
    body: {
      elements: card.elements.map((element) => {
        if (element.type === "text") {
          return { tag: "markdown", content: sanitizeMarkdown(element.text) }
        }

        const actionId = `${ACTION_PREFIX}${element.id}`
        if (element.type === "button") {
          return {
            tag: "button",
            element_id: actionId,
            type: element.style ?? "default",
            size: "medium",
            text: { tag: "plain_text", content: element.label },
            behaviors: [
              {
                type: "callback",
                value: {
                  synergy_response_card: {
                    version: 1,
                    request_id: requestId,
                    action_id: actionId,
                    action_type: "button",
                    value: element.value,
                  },
                },
              },
            ],
          }
        }

        return {
          tag: "select_static",
          element_id: actionId,
          name: actionId,
          placeholder: { tag: "plain_text", content: element.placeholder ?? element.label },
          options: element.options.map((option) => ({
            text: { tag: "plain_text", content: option.label },
            value: option.value,
          })),
          behaviors: [
            {
              type: "callback",
              value: {
                synergy_response_card: {
                  version: 1,
                  request_id: requestId,
                  action_id: actionId,
                  action_type: "select",
                },
              },
            },
          ],
        }
      }),
    },
  }
}

export function parseFeishuResponseCardAction(
  data: unknown,
): { status: "ignored" } | { status: "invalid" } | { status: "valid"; callback: ResponseCardCallback } {
  const outer = CallbackPayload.safeParse(data)
  if (!outer.success) return { status: "ignored" }
  const nested = CallbackPayload.safeParse(outer.data.event)
  const payload = nested.success ? mergePayloads(outer.data, nested.data) : outer.data
  const marker = extractMarker(payload.action?.value)
  if (!marker.present) return { status: "ignored" }

  const envelope = CallbackEnvelope.safeParse(marker.value)
  if (!envelope.success) return { status: "invalid" }
  const messageId = normalize(payload.context?.open_message_id ?? payload.open_message_id)
  const chatId = normalize(payload.context?.open_chat_id ?? payload.open_chat_id)
  const requesterId = normalize(payload.operator?.open_id)
  const tag = normalize(payload.action?.tag)
  if (!messageId || !chatId || !requesterId || !tag) return { status: "invalid" }

  const expectedTag = envelope.data.action_type === "button" ? "button" : "select_static"
  if (tag !== expectedTag) return { status: "invalid" }
  const value =
    envelope.data.action_type === "button" ? normalize(envelope.data.value) : normalize(payload.action?.option)
  if (!value) return { status: "invalid" }

  const callbackBase = {
    requestId: envelope.data.request_id,
    messageId,
    chatId,
    requesterId,
    action: { type: envelope.data.action_type, id: envelope.data.action_id, value },
  }
  const providedEventId = normalize(payload.header?.event_id ?? payload.event_id)
  const eventId =
    providedEventId ??
    sha256Content(
      JSON.stringify({
        token: normalize(payload.token),
        ...callbackBase,
      }),
    )
  const parsedCallback = ResponseCardCallback.safeParse({ eventId, ...callbackBase })
  if (!parsedCallback.success) return { status: "invalid" }
  return { status: "valid", callback: parsedCallback.data }
}

export async function sendFeishuResponseCard(
  input: FeishuApiContext & {
    chatId: string
    replyToMessageId?: string
    replyInThread?: boolean
    requestId: string
    card: ResponseCard
  },
): Promise<{ messageId: string }> {
  const cardJson = renderFeishuResponseCard(input.card, input.requestId)
  const cardBytes = new TextEncoder().encode(JSON.stringify(cardJson)).byteLength
  const budgetedBytes = cardBytes + RESPONSE_CARD_SIZE_RESERVE_BYTES
  if (budgetedBytes > MAX_RESPONSE_CARD_BYTES) {
    throw new Error(
      `Response card too large: ${cardBytes} payload bytes plus ${RESPONSE_CARD_SIZE_RESERVE_BYTES} reserved bytes exceeds ${MAX_RESPONSE_CARD_BYTES} byte limit`,
    )
  }

  const token = await input.getAccessToken()
  const createResponse = await fetch(`${input.apiBase}/cardkit/v1/cards`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const createResult = (await createResponse.json()) as {
    code?: number
    msg?: string
    data?: { card_id?: string }
  }
  if (!createResponse.ok || createResult.code !== 0) {
    throw new Error(
      `Failed to create response card: ${createResult.msg ?? `code ${createResult.code ?? createResponse.status}`}`,
    )
  }
  const cardId = createResult.data?.card_id
  if (!cardId) throw new Error("Failed to create response card: no card_id returned")

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
    throw new Error(`Failed to send response card: ${result.msg ?? `code ${result.code ?? response.status}`}`)
  }
  const messageId = result.data?.message_id
  if (!messageId) throw new Error("Failed to send response card: no message_id returned")
  return { messageId }
}

function sanitizeMarkdown(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|file|data):\/\/\S+/gi, "")
    .trim()
}

function extractMarker(value: unknown): { present: boolean; value?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { present: false }
  if (!Object.hasOwn(value, "synergy_response_card")) return { present: false }
  return { present: true, value: (value as Record<string, unknown>).synergy_response_card }
}

function mergePayloads(outer: CallbackPayload, event: CallbackPayload): CallbackPayload {
  return {
    ...outer,
    ...event,
    header: outer.header,
    event_id: outer.event_id ?? event.event_id,
  }
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized || undefined
}
