import { BrowserProtocolErrorSchema, type BrowserObstruction, type BrowserProtocolErrorData } from "./protocol.js"
import { redactBrowserText, redactBrowserURL } from "./redaction.js"

export type BrowserProtocolErrorInput = Omit<BrowserProtocolErrorData, "type">

export class BrowserProtocolError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly pageId?: string
  readonly commandId?: string
  readonly url?: string
  readonly locator?: BrowserProtocolErrorData["locator"]
  readonly snapshotId?: string
  readonly obstruction?: BrowserObstruction
  readonly suggestedAction?: string

  constructor(input: BrowserProtocolErrorInput, options?: ErrorOptions) {
    const normalized = BrowserProtocolErrorSchema.parse({
      type: "error",
      ...input,
      code: input.code.slice(0, 1_000),
      message: redactBrowserText(input.message).slice(0, 100_000),
      ...(input.pageId ? { pageId: input.pageId.slice(0, 200) } : {}),
      ...(input.commandId ? { commandId: input.commandId.slice(0, 20_000) } : {}),
      ...(input.url ? { url: redactBrowserURL(input.url).slice(0, 20_000) } : {}),
      ...(input.snapshotId ? { snapshotId: input.snapshotId.slice(0, 20_000) } : {}),
      ...(input.suggestedAction ? { suggestedAction: redactBrowserText(input.suggestedAction).slice(0, 100_000) } : {}),
    })
    super(normalized.message, options)
    this.name = "BrowserProtocolError"
    this.code = normalized.code
    this.retryable = normalized.retryable
    this.pageId = normalized.pageId
    this.commandId = normalized.commandId
    this.url = normalized.url
    this.locator = normalized.locator
    this.snapshotId = normalized.snapshotId
    this.obstruction = normalized.obstruction
    this.suggestedAction = normalized.suggestedAction
  }

  toJSON(): BrowserProtocolErrorData {
    return {
      type: "error",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.pageId ? { pageId: this.pageId } : {}),
      ...(this.commandId ? { commandId: this.commandId } : {}),
      ...(this.url ? { url: redactBrowserURL(this.url) } : {}),
      ...(this.locator ? { locator: this.locator } : {}),
      ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
      ...(this.obstruction ? { obstruction: this.obstruction } : {}),
      ...(this.suggestedAction ? { suggestedAction: this.suggestedAction } : {}),
    }
  }

  static from(error: unknown, fallback: BrowserProtocolErrorInput): BrowserProtocolError {
    if (error instanceof BrowserProtocolError) return error
    return new BrowserProtocolError(
      {
        ...fallback,
        message: error instanceof Error ? error.message : fallback.message,
      },
      { cause: error },
    )
  }
}
