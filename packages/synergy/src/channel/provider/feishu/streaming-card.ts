import { Log } from "../../../util/log"
import type * as ChannelTypes from "../../types"
import type { FeishuApiContext } from "./api-context"

const log = Log.create({ service: "channel.feishu.streaming-card" })

const STATUS_ELEMENT_ID = "status_content"
const ANSWER_ELEMENT_ID = "answer_content"
const TOOL_ELEMENT_ID = "tool_content"
const BLANK_MARKDOWN = " "

type StreamingCardOptions = FeishuApiContext & {
  chatId: string
  replyToMessageId?: string
  replyInThread?: boolean
  throttleMs?: number
}

type RenderedSections = {
  statusContent: string
  answerContent: string
  toolContent: string
}

type CardState = {
  cardId: string
  messageId: string
  sequence: number
  answerText: string
  toolProgress: ChannelTypes.StreamingToolProgress[]
  rendered: RenderedSections
}

export function mergeStreamingText(previous: string, next: string): string {
  if (!next) return previous
  if (!previous || next === previous) return next
  if (next.startsWith(previous)) return next
  return previous
}

function truncateSummary(text: string, max = 50): string {
  if (!text) return ""
  const clean = text.replace(/\n/g, " ").trim()
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "..."
}

function normalizeMarkdown(content: string): string {
  return content.trim() ? content : BLANK_MARKDOWN
}

function formatToolLabel(item: ChannelTypes.StreamingToolProgress): string {
  if (!item.title) return item.tool
  if (item.title === item.tool) return item.tool
  return `${item.tool} · ${item.title}`
}

function resolveToolProgressTitle(progress: ChannelTypes.StreamingToolProgress[]): string {
  if (progress.some((item) => item.status === "running" || item.status === "pending")) {
    return "Working"
  }
  if (progress.some((item) => item.status === "error")) {
    return "Completed with errors"
  }
  return "Completed"
}

export function renderToolProgress(progress: ChannelTypes.StreamingToolProgress[]): string {
  if (progress.length === 0) return BLANK_MARKDOWN

  const lines = progress.map((item) => {
    const icon =
      item.status === "completed" ? "✅" : item.status === "error" ? "❌" : item.status === "running" ? "⌨️" : "•"
    return `- ${icon} ${formatToolLabel(item)}`
  })

  const completed = progress.filter((item) => item.status === "completed").length
  const errors = progress.filter((item) => item.status === "error").length
  const summary = `${completed}/${progress.length} completed${errors > 0 ? `, ${errors} failed` : ""}`

  return normalizeMarkdown([`**Tools · ${resolveToolProgressTitle(progress)}**`, ...lines, "", summary].join("\n"))
}

function renderAnswerContent(answerText: string): string {
  return normalizeMarkdown(answerText)
}

function renderStatusContent(state: Pick<CardState, "answerText" | "toolProgress">, closed: boolean): string {
  if (closed) {
    if (state.toolProgress.some((item) => item.status === "error")) {
      return "✅ 已完成（含工具错误）"
    }
    return "✅ 已完成"
  }

  if (state.toolProgress.some((item) => item.status === "running" || item.status === "pending")) {
    return "🔧 正在使用工具…"
  }

  if (state.answerText.trim()) {
    return "💬 正在生成回答…"
  }

  return "⏳ 思考中..."
}

function renderSections(state: Pick<CardState, "answerText" | "toolProgress">, closed: boolean): RenderedSections {
  return {
    statusContent: renderStatusContent(state, closed),
    answerContent: renderAnswerContent(state.answerText),
    toolContent: renderToolProgress(state.toolProgress),
  }
}

export class FeishuStreamingCard implements ChannelTypes.StreamingSession {
  private state: CardState | null = null
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  private lastUpdateTime = 0
  private pendingText: string | null = null
  private trailingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly throttleMs: number
  private readonly opts: StreamingCardOptions

  constructor(opts: StreamingCardOptions) {
    this.opts = opts
    this.throttleMs = opts.throttleMs ?? 100
  }

  async start(): Promise<void> {
    if (this.state) return

    const token = await this.opts.getAccessToken()
    const initialSections = renderSections({ answerText: "", toolProgress: [] }, false)

    const cardJson = {
      schema: "2.0",
      config: {
        update_multi: true,
        streaming_mode: true,
        summary: { content: "[生成中...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
          print_strategy: "fast",
        },
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: initialSections.statusContent,
            element_id: STATUS_ELEMENT_ID,
          },
          {
            tag: "markdown",
            content: initialSections.answerContent,
            element_id: ANSWER_ELEMENT_ID,
          },
          {
            tag: "markdown",
            content: initialSections.toolContent,
            element_id: TOOL_ELEMENT_ID,
          },
        ],
      },
    }

    const createResponse = await fetch(`${this.opts.apiBase}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "card_json",
        data: JSON.stringify(cardJson),
      }),
    })

    const createResult = (await createResponse.json()) as { data?: { card_id?: string }; code?: number; msg?: string }
    if (createResult.code !== 0) {
      throw new Error(`Failed to create card: ${createResult.msg ?? `code ${createResult.code}`}`)
    }
    const cardId = createResult.data?.card_id
    if (!cardId) throw new Error("Failed to create streaming card: no card_id returned")

    const cardContent = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    })

    let messageId: string | undefined
    if (this.opts.replyToMessageId) {
      const replyResponse = await fetch(`${this.opts.apiBase}/im/v1/messages/${this.opts.replyToMessageId}/reply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: cardContent,
          msg_type: "interactive",
          ...(this.opts.replyInThread ? { reply_in_thread: true } : {}),
        }),
      })
      const replyResult = (await replyResponse.json()) as {
        code?: number
        msg?: string
        data?: { message_id?: string }
      }
      if (replyResult.code !== 0) {
        throw new Error(`Failed to reply with card: ${replyResult.msg ?? `code ${replyResult.code}`}`)
      }
      messageId = replyResult.data?.message_id ?? undefined
    } else {
      const createMsgResponse = await fetch(`${this.opts.apiBase}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: this.opts.chatId,
          content: cardContent,
          msg_type: "interactive",
        }),
      })
      const createMsgResult = (await createMsgResponse.json()) as {
        code?: number
        msg?: string
        data?: { message_id?: string }
      }
      if (createMsgResult.code !== 0) {
        throw new Error(`Failed to send card: ${createMsgResult.msg ?? `code ${createMsgResult.code}`}`)
      }
      messageId = createMsgResult.data?.message_id ?? undefined
    }

    if (!messageId) throw new Error("Failed to send streaming card: no message_id returned")

    this.state = {
      cardId,
      messageId,
      sequence: 1,
      answerText: "",
      toolProgress: [],
      rendered: initialSections,
    }
    log.info("streaming card started", { cardId, messageId })
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) return

    const merged = mergeStreamingText(this.pendingText ?? this.state.answerText, text)
    if (!merged || merged === this.state.answerText) return

    const now = Date.now()
    if (now - this.lastUpdateTime < this.throttleMs) {
      this.pendingText = merged
      this.scheduleTrailingFlush()
      return
    }

    this.clearTrailingTimer()
    this.pendingText = null
    this.lastUpdateTime = now
    await this.enqueueRender({ answerText: merged })
  }

  async updateToolProgress(progress: ChannelTypes.StreamingToolProgress[]): Promise<void> {
    if (!this.state || this.closed) return
    await this.enqueueRender({ toolProgress: progress })
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) return
    this.closed = true
    this.clearTrailingTimer()
    await this.queue

    const text = finalText?.trim() ? finalText : (this.pendingText ?? this.state.answerText)
    this.pendingText = null

    await this.applyRender(
      {
        answerText: text,
        toolProgress: this.state.toolProgress,
      },
      true,
    )

    const summaryText = text || this.state.answerText
    try {
      const token = await this.opts.getAccessToken()
      await fetch(`${this.opts.apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: truncateSummary(summaryText) },
            },
          }),
          sequence: this.nextSequence(),
          uuid: `c_${this.state.cardId}_${this.state.sequence}`,
        }),
      })
    } catch (error) {
      log.error("streaming card close failed", { error, cardId: this.state.cardId })
    }

    log.info("streaming card closed", { cardId: this.state.cardId })
  }

  isActive(): boolean {
    return this.state !== null && !this.closed
  }

  private enqueueRender(update: Partial<Pick<CardState, "answerText" | "toolProgress">>) {
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return
      await this.applyRender(
        {
          answerText: update.answerText ?? this.state.answerText,
          toolProgress: update.toolProgress ?? this.state.toolProgress,
        },
        false,
      )
    })
    return this.queue
  }

  private async applyRender(nextState: Pick<CardState, "answerText" | "toolProgress">, closed: boolean) {
    if (!this.state) return

    const nextRendered = renderSections(nextState, closed)
    const updates: Array<{ elementId: string; content: string }> = []

    if (nextRendered.statusContent !== this.state.rendered.statusContent) {
      updates.push({ elementId: STATUS_ELEMENT_ID, content: nextRendered.statusContent })
    }
    if (nextRendered.answerContent !== this.state.rendered.answerContent) {
      updates.push({ elementId: ANSWER_ELEMENT_ID, content: nextRendered.answerContent })
    }
    if (nextRendered.toolContent !== this.state.rendered.toolContent) {
      updates.push({ elementId: TOOL_ELEMENT_ID, content: nextRendered.toolContent })
    }

    this.state.answerText = nextState.answerText
    this.state.toolProgress = nextState.toolProgress
    this.state.rendered = nextRendered

    for (const update of updates) {
      await this.updateElementContent(update.elementId, update.content)
    }
  }

  private async updateElementContent(elementId: string, content: string) {
    if (!this.state) return

    try {
      const token = await this.opts.getAccessToken()
      await fetch(`${this.opts.apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          content,
          sequence: this.nextSequence(),
          uuid: `s_${this.state.cardId}_${this.state.sequence}_${elementId}`,
        }),
      })
    } catch (error) {
      log.error("streaming card update failed", { error, cardId: this.state.cardId, elementId })
    }
  }

  private nextSequence(): number {
    if (!this.state) return 0
    this.state.sequence += 1
    return this.state.sequence
  }

  private scheduleTrailingFlush() {
    if (this.trailingTimer) return
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null
      if (!this.state || this.closed || !this.pendingText) return
      const text = this.pendingText
      this.pendingText = null
      this.lastUpdateTime = Date.now()
      void this.enqueueRender({ answerText: text })
    }, this.throttleMs)
  }

  private clearTrailingTimer() {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer)
      this.trailingTimer = null
    }
  }
}
