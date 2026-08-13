import z from "zod"
import type { Question } from "@/question"
import { sha256Content } from "@/util/crypto"
import { QuestionCardCallback } from "../../types"
import type { FeishuApiContext } from "./api-context"
import {
  normalizeFeishuCallbackString as normalize,
  sanitizeFeishuCardMarkdown as sanitizeMarkdown,
  sendFeishuCard,
} from "./send-card"

const MAX_CARD_BYTES = 30 * 1024
const CARD_SIZE_RESERVE_BYTES = 2 * 1024

const CallbackEnvelope = z
  .object({
    version: z.literal(1),
    request_id: z.string().min(1).max(200),
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
        form_value: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

type CallbackPayload = z.infer<typeof CallbackPayload>

type CardJson = {
  schema: "2.0"
  config: { update_multi: true; summary: { content: string } }
  header: { title: { tag: "plain_text"; content: string }; template: string }
  body: { elements: unknown[] }
}

export function renderFeishuQuestionCard(questions: Question.Info[], requestId: string): CardJson {
  const formElements = questions.flatMap((question, questionIndex) => {
    const fieldName = `question_${questionIndex}`
    const options = question.options.map((option, optionIndex) => ({
      text: { tag: "plain_text", content: option.label },
      value: String(optionIndex),
    }))
    return [
      { tag: "markdown", content: sanitizeMarkdown(`**${question.header}**\n${question.question}`) },
      {
        tag: question.multiple ? "multi_select_static" : "select_static",
        element_id: `q${questionIndex}`,
        name: fieldName,
        required: false,
        width: "fill",
        placeholder: {
          tag: "plain_text",
          content: question.multiple ? "请选择一个或多个选项" : "请选择一个选项",
        },
        options,
      },
      {
        tag: "input",
        element_id: `o${questionIndex}`,
        name: `${fieldName}_custom`,
        required: false,
        max_length: 1_000,
        input_type: "text",
        width: "fill",
        placeholder: { tag: "plain_text", content: "其他答案（可选）" },
      },
    ]
  })

  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "需要你的选择" } },
    header: { title: { tag: "plain_text", content: "请回答" }, template: "blue" },
    body: {
      elements: [
        {
          tag: "form",
          name: "question_form",
          elements: [
            ...formElements,
            {
              tag: "button",
              element_id: "submit",
              name: "submit",
              type: "primary",
              text: { tag: "plain_text", content: "提交" },
              form_action_type: "submit",
              behaviors: [
                {
                  type: "callback",
                  value: {
                    synergy_question_card: {
                      version: 1,
                      request_id: requestId,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

export function parseFeishuQuestionCardAction(
  data: unknown,
): { status: "ignored" } | { status: "invalid" } | { status: "valid"; callback: QuestionCardCallback } {
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
  const form = payload.action?.form_value
  if (payload.action?.tag !== "button" || !messageId || !chatId || !requesterId || !form) {
    return { status: "invalid" }
  }

  const formValues = parseFormValues(form)
  if (!formValues?.length) return { status: "invalid" }
  const callbackBase = {
    requestId: envelope.data.request_id,
    messageId,
    chatId,
    requesterId,
    formValues,
  }
  const eventId =
    normalize(payload.header?.event_id ?? payload.event_id) ??
    sha256Content(JSON.stringify({ token: normalize(payload.token), ...callbackBase }))
  const parsed = QuestionCardCallback.safeParse({ eventId, ...callbackBase })
  if (!parsed.success) return { status: "invalid" }
  return { status: "valid", callback: parsed.data }
}

export async function sendFeishuQuestionCard(
  input: FeishuApiContext & {
    chatId: string
    replyToMessageId?: string
    replyInThread?: boolean
    requestId: string
    questions: Question.Info[]
  },
): Promise<{ messageId: string; threadId?: string }> {
  const cardJson = renderFeishuQuestionCard(input.questions, input.requestId)
  const cardBytes = new TextEncoder().encode(JSON.stringify(cardJson)).byteLength
  if (cardBytes + CARD_SIZE_RESERVE_BYTES > MAX_CARD_BYTES) {
    throw new Error(
      `Question card too large: ${cardBytes} payload bytes plus ${CARD_SIZE_RESERVE_BYTES} reserved bytes exceeds ${MAX_CARD_BYTES} byte limit`,
    )
  }
  return sendFeishuCard({ ...input, cardJson, kind: "question card" })
}

function parseFormValues(form: Record<string, unknown>): QuestionCardCallback["formValues"] | undefined {
  const questionNames = Array.from(
    new Set(
      Object.keys(form).flatMap((name) => {
        const match = /^question_(\d+)(?:_custom)?$/.exec(name)
        return match ? [`question_${match[1]}`] : []
      }),
    ),
  ).sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
  const values: QuestionCardCallback["formValues"] = []
  for (const name of questionNames) {
    const rawSelected = form[name]
    const selected =
      typeof rawSelected === "string"
        ? [rawSelected]
        : Array.isArray(rawSelected) && rawSelected.every((item) => typeof item === "string")
          ? rawSelected
          : rawSelected == null
            ? []
            : undefined
    if (!selected) return undefined
    const rawCustom = form[`${name}_custom`]
    if (rawCustom != null && typeof rawCustom !== "string") return undefined
    const custom = normalize(rawCustom)
    values.push({ name, selected, ...(custom ? { custom } : {}) })
  }
  return values
}

function extractMarker(value: unknown): { present: boolean; value?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { present: false }
  if (!Object.hasOwn(value, "synergy_question_card")) return { present: false }
  return { present: true, value: (value as Record<string, unknown>).synergy_question_card }
}

function mergePayloads(outer: CallbackPayload, event: CallbackPayload): CallbackPayload {
  return {
    ...outer,
    ...event,
    header: outer.header,
    event_id: outer.event_id ?? event.event_id,
  }
}

/**
 * Renders the read-only "submitted" summary card that replaces the question
 * form in the card callback response. Feishu requires the replacement card
 * to be returned synchronously from the callback (within 3 seconds); a
 * background CardKit update is rolled back by the client.
 */
export function renderFeishuQuestionCardSummary(questions: Question.Info[], answers: Question.Answer[]): CardJson {
  const elements = questions.map((question, index) => {
    const answer = answers[index] ?? []
    const answerText = answer.length > 0 ? answer.join("、") : "（未回答）"
    return {
      tag: "markdown",
      content: sanitizeMarkdown(`**${question.header}**\n${question.question}\n\n**回答：** ${answerText}`),
    }
  })

  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "回答已提交" } },
    header: { title: { tag: "plain_text", content: "回答已提交" }, template: "green" },
    body: { elements },
  }
}

/**
 * Provider-level summary renderer with the 30 KiB CardKit bound. Returns
 * undefined when the summary would exceed the limit so the callback can fall
 * back to a plain toast instead of failing the interaction.
 */
export function renderFeishuQuestionCardSummarySafe(
  questions: Question.Info[],
  answers: Question.Answer[],
): CardJson | undefined {
  const cardJson = renderFeishuQuestionCardSummary(questions, answers)
  const cardBytes = new TextEncoder().encode(JSON.stringify(cardJson)).byteLength
  if (cardBytes + CARD_SIZE_RESERVE_BYTES > MAX_CARD_BYTES) return undefined
  return cardJson
}
