import { Log } from "../../../util/log"
import type * as ChannelTypes from "../../types"
import type { FeishuApiContext } from "./api-context"
import { degradeMarkdownImages, materializeMarkdownImages } from "./markdown-image"
import { FeishuStreamingState } from "./streaming-state"

const log = Log.create({ service: "channel.feishu.streaming-card" })

const STATUS_ELEMENT_ID = "status_content"
const ANSWER_ELEMENT_ID = "answer_content"
const TOOL_ELEMENT_ID = "tool_content"
const BLANK_MARKDOWN = " "
const CARD_MUTATION_INTERVAL_MS = 100
const CARD_MUTATION_ATTEMPTS = 3
const CARD_REQUEST_TIMEOUT_MS = 15_000
const MAX_STREAMING_CARD_BYTES = 30 * 1024
const CARD_SIZE_RESERVE_BYTES = 2 * 1024

type StreamingCardOptions = FeishuApiContext & {
  chatId: string
  replyToMessageId?: string
  replyInThread?: boolean
  throttleMs?: number
  requestTimeoutMs?: number
  sendFallback?: (text: string) => Promise<void>
  persistence?: { accountId: string; sessionID: string }
  onThreadCreated?: (threadId: string) => Promise<void>
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
  error?: boolean
}

type FeishuApiResult = {
  code?: number
  msg?: string
}

class FeishuRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined,
    readonly terminal: boolean,
    readonly transient: boolean,
  ) {
    super(message)
  }
}

async function assertFeishuSuccess(response: Response, operation: string): Promise<void> {
  let result: FeishuApiResult
  try {
    result = (await response.json()) as FeishuApiResult
  } catch {
    throw new FeishuRequestError(
      `${operation} failed: HTTP ${response.status}`,
      response.status,
      undefined,
      false,
      response.status >= 500,
    )
  }

  if (response.ok && result.code === 0) return

  const detail = result.msg ?? `code ${result.code ?? response.status}`
  const normalized = detail.toLowerCase()
  const terminal =
    result.code === 300309 ||
    normalized.includes("streaming mode is closed") ||
    normalized.includes("streaming mode already closed") ||
    normalized.includes("streaming timeout") ||
    normalized.includes("card expired")
  const transient =
    !terminal &&
    (response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500 ||
      normalized.includes("rate limit") ||
      normalized.includes("too many requests") ||
      normalized.includes("system busy") ||
      normalized.includes("temporarily unavailable"))

  throw new FeishuRequestError(`${operation} failed: ${detail}`, response.status, result.code, terminal, transient)
}

function isTransientTransportError(cause: unknown): boolean {
  return (
    cause instanceof TypeError ||
    (cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError"))
  )
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
  // Incremental renders must stay synchronous: degrade image syntax to links
  // so Feishu never rejects the card element. The final answer is materialized
  // (downloaded and uploaded to image_key) once in finalize().
  return normalizeMarkdown(degradeMarkdownImages(answerText))
}

function renderStatusContent(state: Pick<CardState, "answerText" | "toolProgress" | "error">, closed: boolean): string {
  if (closed) {
    if (state.error) return "❌ Generation failed"
    if (state.toolProgress.some((item) => item.status === "error")) return "✅ Completed with tool errors"
    return "✅ Completed"
  }

  if (state.error) return "❌ Generation failed"
  if (state.toolProgress.some((item) => item.status === "generating")) return "📝 Generating tool arguments…"
  if (state.toolProgress.some((item) => item.status === "running" || item.status === "pending")) {
    return "🔧 Using tools…"
  }
  if (state.answerText.trim()) return "💬 Generating response…"
  return "⏳ Thinking…"
}

function renderSections(
  state: Pick<CardState, "answerText" | "toolProgress" | "error">,
  closed: boolean,
): RenderedSections {
  return {
    statusContent: renderStatusContent(state, closed),
    answerContent: renderAnswerContent(state.answerText),
    toolContent: renderToolProgress(state.toolProgress),
  }
}

export class FeishuStreamingCard implements ChannelTypes.StreamingSession {
  private state: CardState | null = null
  private phase: "idle" | "active" | "closing" | "closed" = "idle"
  private writer: Promise<void> = Promise.resolve()
  private startPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private fallbackPromise: Promise<void> | null = null
  private renderPromise: Promise<void> | null = null
  private terminalCause: unknown
  private desiredAnswerText = ""
  private desiredToolProgress: ChannelTypes.StreamingToolProgress[] = []
  private desiredError: boolean | undefined
  private lastRenderTime = 0
  private lastMutationTime = 0
  private readonly throttleMs: number
  private readonly requestTimeoutMs: number
  private readonly opts: StreamingCardOptions

  constructor(opts: StreamingCardOptions) {
    this.opts = opts
    this.throttleMs = opts.throttleMs ?? 100
    this.requestTimeoutMs = opts.requestTimeoutMs ?? CARD_REQUEST_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.startCard()
    return this.startPromise
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.phase !== "active") return
    this.desiredAnswerText = text
    if (this.terminalCause) return
    await this.enqueueRender()
  }

  async updateToolProgress(progress: ChannelTypes.StreamingToolProgress[]): Promise<void> {
    if (!this.state || this.phase !== "active") return
    this.desiredToolProgress = progress.map((item) => ({ ...item }))
    if (this.terminalCause) return
    await this.enqueueRender()
  }

  close(finalText?: string, error?: boolean): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (!this.state || this.phase === "closed") return Promise.resolve()

    if (finalText?.trim()) this.desiredAnswerText = finalText
    this.desiredError = error
    this.phase = "closing"
    this.closePromise = this.enqueueWriter(() => this.finalize())
    return this.closePromise
  }

  isActive(): boolean {
    return this.state !== null && this.phase === "active"
  }

  ownsTerminalDelivery(): boolean {
    return true
  }

  private async startCard(): Promise<void> {
    if (this.state) return

    const token = await this.opts.getAccessToken()
    const initialSections = renderSections({ answerText: "", toolProgress: [] }, false)
    const cardJson = {
      schema: "2.0",
      config: {
        update_multi: true,
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
          print_strategy: "fast",
        },
      },
      body: {
        elements: [
          { tag: "markdown", content: initialSections.statusContent, element_id: STATUS_ELEMENT_ID },
          { tag: "markdown", content: initialSections.answerContent, element_id: ANSWER_ELEMENT_ID },
          { tag: "markdown", content: initialSections.toolContent, element_id: TOOL_ELEMENT_ID },
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
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    const createResult = (await createResponse.json()) as {
      data?: { card_id?: string }
      code?: number
      msg?: string
    }
    if (!createResponse.ok || createResult.code !== 0) {
      throw new Error(
        `Failed to create card: ${createResult.msg ?? `code ${createResult.code ?? createResponse.status}`}`,
      )
    }
    const cardId = createResult.data?.card_id
    if (!cardId) throw new Error("Failed to create streaming card: no card_id returned")

    if (this.opts.persistence) {
      await FeishuStreamingState.persist({
        ...this.opts.persistence,
        cardId,
      })
    }
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } })
    const sent = await this.sendCardMessage(token, cardContent)
    if (sent.threadId) await this.opts.onThreadCreated?.(sent.threadId)
    if (this.opts.persistence) {
      await FeishuStreamingState.persist({
        ...this.opts.persistence,
        cardId,
        messageId: sent.messageId,
      })
    }
    this.state = {
      cardId,
      messageId: sent.messageId,
      sequence: 1,
      answerText: "",
      toolProgress: [],
      rendered: initialSections,
    }
    this.phase = "active"
    log.info("streaming card started", { cardId, messageId: sent.messageId })
  }

  private async sendCardMessage(token: string, cardContent: string): Promise<ChannelTypes.SendResult> {
    if (this.opts.replyToMessageId) {
      const response = await fetch(`${this.opts.apiBase}/im/v1/messages/${this.opts.replyToMessageId}/reply`, {
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
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
      const result = (await response.json()) as {
        code?: number
        msg?: string
        data?: { message_id?: string; thread_id?: string }
      }
      if (!response.ok || result.code !== 0) {
        throw new Error(`Failed to reply with card: ${result.msg ?? `code ${result.code ?? response.status}`}`)
      }
      if (!result.data?.message_id) throw new Error("Failed to send streaming card: no message_id returned")
      return { messageId: result.data.message_id, threadId: result.data.thread_id }
    }

    const response = await fetch(`${this.opts.apiBase}/im/v1/messages?receive_id_type=chat_id`, {
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
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    const result = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
    if (!response.ok || result.code !== 0) {
      throw new Error(`Failed to send card: ${result.msg ?? `code ${result.code ?? response.status}`}`)
    }
    if (!result.data?.message_id) throw new Error("Failed to send streaming card: no message_id returned")
    return { messageId: result.data.message_id }
  }

  private enqueueRender(): Promise<void> {
    if (this.renderPromise) return this.renderPromise

    let renderedSuccessfully = false
    const run = this.enqueueWriter(async () => {
      if (this.phase !== "active" || this.terminalCause) return
      await this.paceRender()
      const desired = this.desiredState()
      const rendered = renderSections(desired, false)
      if (this.isCardTooLarge(rendered)) return
      await this.applyRender(desired, rendered)
      renderedSuccessfully = true
    })
    this.renderPromise = run.finally(() => {
      this.renderPromise = null
      if (!renderedSuccessfully || this.phase !== "active" || this.terminalCause || !this.hasPendingRender()) return
      void this.enqueueRender().catch((error) => log.warn("streaming card coalesced render failed", { error }))
    })
    return this.renderPromise
  }

  private enqueueWriter(operation: () => Promise<void>): Promise<void> {
    const run = this.writer.then(operation)
    this.writer = run.catch(() => {})
    return run
  }

  private desiredState(): Pick<CardState, "answerText" | "toolProgress" | "error"> {
    return {
      answerText: this.desiredAnswerText,
      toolProgress: this.desiredToolProgress.map((item) => ({ ...item })),
      error: this.desiredError,
    }
  }

  private hasPendingRender(): boolean {
    if (!this.state) return false
    if (this.state.answerText !== this.desiredAnswerText || this.state.error !== this.desiredError) return true
    if (this.state.toolProgress.length !== this.desiredToolProgress.length) return true
    return this.state.toolProgress.some((item, index) => {
      const desired = this.desiredToolProgress[index]
      return !desired || item.id !== desired.id || item.status !== desired.status || item.title !== desired.title
    })
  }

  private async finalize(): Promise<void> {
    if (!this.state) return

    const desired = this.desiredState()
    const finalRendered = renderSections(desired, true)
    const text = desired.answerText
    const tooLarge = this.isCardTooLarge(finalRendered)
    let deliveryFailure = this.terminalCause

    try {
      if (!deliveryFailure && !tooLarge) {
        try {
          // The final answer is written once: materialize image URLs into
          // image_key so the closed card renders real images instead of links.
          // Materialize the raw text (the rendered sections are already
          // degraded), then render it with the same pipeline as increments.
          const materializedAnswer = renderAnswerContent(await materializeMarkdownImages(desired.answerText, this.opts))
          await this.applyRender(desired, { ...finalRendered, answerContent: materializedAnswer })
        } catch (cause) {
          deliveryFailure = cause
          log.error("streaming card final content update failed", { error: cause, cardId: this.state.cardId })
        }
      }

      if (!this.terminalCause) {
        try {
          await this.closeStreamingMode(text)
          await this.removePersistedState()
        } catch (cause) {
          deliveryFailure ??= cause
          log.error("streaming card settings update failed", { error: cause, cardId: this.state.cardId })
        }
      } else if (this.terminalCause instanceof FeishuRequestError && this.terminalCause.terminal) {
        await this.removePersistedState()
      }

      if (tooLarge || deliveryFailure) {
        const cause =
          deliveryFailure ?? new Error(`Streaming card exceeds the ${MAX_STREAMING_CARD_BYTES}-byte CardKit limit`)
        if (!this.opts.sendFallback) {
          log.error("streaming card final answer could not be delivered", {
            cardId: this.state.cardId,
            error: cause,
            fallbackAvailable: false,
          })
        }
        if (!text || !this.opts.sendFallback) throw cause
        await this.sendFallbackOnce(text)
        log.warn("streaming card final answer sent as text fallback", { cardId: this.state.cardId })
        return
      }

      log.info("streaming card closed", { cardId: this.state.cardId })
    } finally {
      this.phase = "closed"
    }
  }

  private async applyRender(
    nextState: Pick<CardState, "answerText" | "toolProgress" | "error">,
    nextRendered: RenderedSections,
  ) {
    if (!this.state) return
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

    for (const update of updates) {
      await this.updateElementContent(update.elementId, update.content)
    }

    this.state.answerText = nextState.answerText
    this.state.toolProgress = nextState.toolProgress
    this.state.error = nextState.error
    this.state.rendered = nextRendered
  }

  private async updateElementContent(elementId: string, content: string): Promise<void> {
    if (!this.state) return
    const sequence = this.nextSequence()
    await this.runCardMutation(`Update streaming card element ${elementId}`, async () => {
      const token = await this.opts.getAccessToken()
      return fetch(`${this.opts.apiBase}/cardkit/v1/cards/${this.state!.cardId}/elements/${elementId}/content`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          content,
          sequence,
          uuid: `s_${this.state!.cardId}_${sequence}_${elementId}`,
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    })
  }

  private async closeStreamingMode(summaryText: string): Promise<void> {
    if (!this.state) return
    const sequence = this.nextSequence()
    await this.runCardMutation("Close streaming card", async () => {
      const token = await this.opts.getAccessToken()
      return fetch(`${this.opts.apiBase}/cardkit/v1/cards/${this.state!.cardId}/settings`, {
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
          sequence,
          uuid: `c_${this.state!.cardId}_${sequence}`,
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    })
  }

  private async runCardMutation(operation: string, request: () => Promise<Response>): Promise<void> {
    if (this.terminalCause) throw this.terminalCause

    for (let attempt = 1; attempt <= CARD_MUTATION_ATTEMPTS; attempt += 1) {
      await this.paceMutation()
      try {
        const response = await request()
        await assertFeishuSuccess(response, operation)
        return
      } catch (cause) {
        if (cause instanceof FeishuRequestError && cause.terminal) {
          this.terminalCause = cause
          throw cause
        }
        const retryable = isTransientTransportError(cause) || (cause instanceof FeishuRequestError && cause.transient)
        if (!retryable || attempt === CARD_MUTATION_ATTEMPTS) throw cause
        log.warn("streaming card mutation retrying", {
          operation,
          attempt,
          error: cause,
          cardId: this.state?.cardId,
        })
      }
    }
  }

  private async paceRender(): Promise<void> {
    const waitMs = this.throttleMs - (Date.now() - this.lastRenderTime)
    if (waitMs > 0) await Bun.sleep(waitMs)
    this.lastRenderTime = Date.now()
  }

  private async paceMutation(): Promise<void> {
    const waitMs = CARD_MUTATION_INTERVAL_MS - (Date.now() - this.lastMutationTime)
    if (waitMs > 0) await Bun.sleep(waitMs)
    this.lastMutationTime = Date.now()
  }

  private async removePersistedState(): Promise<void> {
    if (!this.opts.persistence || !this.state) return
    await FeishuStreamingState.remove({ ...this.opts.persistence, cardId: this.state.cardId }).catch((error) =>
      log.warn("failed to clear streaming card state", { cardId: this.state?.cardId, error }),
    )
  }

  private isCardTooLarge(rendered: RenderedSections): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(rendered)).byteLength + CARD_SIZE_RESERVE_BYTES
    return bytes > MAX_STREAMING_CARD_BYTES
  }

  private sendFallbackOnce(text: string): Promise<void> {
    if (!this.opts.sendFallback) return Promise.reject(new Error("Streaming fallback is unavailable"))
    if (!this.fallbackPromise) this.fallbackPromise = this.opts.sendFallback(text)
    return this.fallbackPromise
  }

  private nextSequence(): number {
    if (!this.state) return 0
    this.state.sequence += 1
    return this.state.sequence
  }
}
