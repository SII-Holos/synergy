import type { Page } from "playwright"
import { BrowserCDP, type CDPHandle } from "./cdp.js"

export interface BrowserFrameMetadata {
  width: number
  height: number
  deviceScaleFactor: number
  pageScaleFactor?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
  timestamp: number
}

export interface BrowserScreencastFrame {
  tabId: string
  encoding: "base64"
  mime: "image/jpeg" | "image/png"
  data: string
  metadata: BrowserFrameMetadata
}

export interface BrowserScreencastOptions {
  format?: "jpeg" | "png"
  quality?: number
  maxWidth?: number
  maxHeight?: number
  everyNthFrame?: number
  fps?: number
}

interface StreamState {
  tabId: string
  stop: () => Promise<void>
}

function mime(format: "jpeg" | "png"): "image/jpeg" | "image/png" {
  return format === "png" ? "image/png" : "image/jpeg"
}

function viewportMetadata(page: Page): BrowserFrameMetadata {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  return {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 1,
    timestamp: Date.now(),
  }
}

function inferFrameData(frame: unknown): string | null {
  if (!frame) return null
  if (Buffer.isBuffer(frame)) return frame.toString("base64")
  if (frame instanceof Uint8Array) return Buffer.from(frame).toString("base64")
  if (typeof frame === "string") {
    const comma = frame.indexOf(",")
    return comma >= 0 ? frame.slice(comma + 1) : frame
  }
  const value = frame as Record<string, unknown>
  if (typeof value.data === "string") return value.data
  if (Buffer.isBuffer(value.buffer)) return value.buffer.toString("base64")
  if (value.buffer instanceof Uint8Array) return Buffer.from(value.buffer).toString("base64")
  return null
}

function createFrameGate(fps: number | undefined) {
  const target = fps && Number.isFinite(fps) && fps > 0 ? fps : 20
  const minInterval = 1000 / target
  let last = 0
  return () => {
    const now = Date.now()
    if (now - last < minInterval) return false
    last = now
    return true
  }
}

function inferPlaywrightMetadata(page: Page, frame: unknown): BrowserFrameMetadata {
  const fallback = viewportMetadata(page)
  const value = frame as Record<string, unknown>
  const width = typeof value.width === "number" ? value.width : fallback.width
  const height = typeof value.height === "number" ? value.height : fallback.height
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : Date.now()
  return { ...fallback, width, height, timestamp }
}

export class BrowserFrameStreamer {
  private active = new Map<string, StreamState>()

  isStreaming(tabId: string): boolean {
    return this.active.has(tabId)
  }

  async start(
    tabId: string,
    page: Page,
    options: BrowserScreencastOptions,
    onFrame: (frame: BrowserScreencastFrame) => void,
  ): Promise<void> {
    await this.stop(tabId)
    const format = options.format ?? "jpeg"
    const quality = options.quality ?? 70
    const shouldEmitFrame = createFrameGate(options.fps)

    const playwrightStop = await this.tryPlaywrightScreencast(tabId, page, format, quality, shouldEmitFrame, onFrame)
    if (playwrightStop) {
      this.active.set(tabId, { tabId, stop: playwrightStop })
      return
    }

    const cdpStop = await this.startCDPScreencast(tabId, page, options, onFrame)
    this.active.set(tabId, { tabId, stop: cdpStop })
  }

  async stop(tabId: string): Promise<void> {
    const state = this.active.get(tabId)
    if (!state) return
    this.active.delete(tabId)
    await state.stop().catch(() => {})
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.active.keys()).map((tabId) => this.stop(tabId)))
  }

  private async tryPlaywrightScreencast(
    tabId: string,
    page: Page,
    format: "jpeg" | "png",
    quality: number,
    shouldEmitFrame: () => boolean,
    onFrame: (frame: BrowserScreencastFrame) => void,
  ): Promise<(() => Promise<void>) | null> {
    const screencast = (page as unknown as { screencast?: { start?: (...args: any[]) => Promise<any> } }).screencast
    if (!screencast?.start) return null

    try {
      const controller = await screencast.start({ format, quality }, (frame: unknown) => {
        if (!shouldEmitFrame()) return
        const data = inferFrameData(frame)
        if (!data) return
        onFrame({
          tabId,
          encoding: "base64",
          mime: mime(format),
          data,
          metadata: inferPlaywrightMetadata(page, frame),
        })
      })
      return async () => {
        if (controller?.stop) await controller.stop()
      }
    } catch {
      return null
    }
  }

  private async startCDPScreencast(
    tabId: string,
    page: Page,
    options: BrowserScreencastOptions,
    onFrame: (frame: BrowserScreencastFrame) => void,
  ): Promise<() => Promise<void>> {
    const format = options.format ?? "jpeg"
    const shouldEmitFrame = createFrameGate(options.fps)
    const cdp = await BrowserCDP.attach(page)
    const unsubscribe = cdp.on<{
      data: string
      metadata?: {
        deviceWidth?: number
        deviceHeight?: number
        pageScaleFactor?: number
        scrollOffsetX?: number
        scrollOffsetY?: number
        timestamp?: number
      }
      sessionId: number
    }>("Page.screencastFrame", (event) => {
      cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {})
      if (!shouldEmitFrame()) return
      const vp = page.viewportSize() ?? { width: 1280, height: 720 }
      onFrame({
        tabId,
        encoding: "base64",
        mime: mime(format),
        data: event.data,
        metadata: {
          width: event.metadata?.deviceWidth ?? vp.width,
          height: event.metadata?.deviceHeight ?? vp.height,
          deviceScaleFactor: 1,
          pageScaleFactor: event.metadata?.pageScaleFactor,
          scrollOffsetX: event.metadata?.scrollOffsetX,
          scrollOffsetY: event.metadata?.scrollOffsetY,
          timestamp: event.metadata?.timestamp ? event.metadata.timestamp * 1000 : Date.now(),
        },
      })
    })

    await cdp.send("Page.startScreencast", {
      format,
      quality: options.quality ?? 70,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      everyNthFrame: options.everyNthFrame ?? 1,
    })

    return async () => {
      unsubscribe()
      await cdp.send("Page.stopScreencast").catch(() => {})
      await cdp.detach().catch(() => {})
    }
  }
}
