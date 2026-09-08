import type { WebContents, WebFrameMain } from "electron"

type PendingMessage = {
  channel: string
  args: unknown[]
}

export class DesktopRendererDelivery {
  private ready = false
  private disposed = false
  private readonly latest = new Map<string, PendingMessage>()
  private readonly queue: PendingMessage[] = []

  constructor(private readonly contents: WebContents) {
    contents.on("did-start-navigation", this.onDidStartNavigation)
    contents.on("render-process-gone", this.markUnavailable)
    contents.on("destroyed", this.markUnavailable)
  }

  markReady(frame: WebFrameMain | null): boolean {
    if (!frame || !this.isCurrentDeliverableFrame(frame)) {
      this.ready = false
      return false
    }
    this.ready = true
    this.flushPending()
    return this.ready
  }

  readonly send = (channel: string, ...args: unknown[]): boolean => {
    if (!this.ready) return false
    const frame = this.deliverableFrame()
    if (!frame) {
      this.ready = false
      return false
    }
    try {
      frame.send(channel, ...args)
      return true
    } catch (error) {
      if (!this.frameUnavailable(frame)) throw error
      this.ready = false
      return false
    }
  }

  sendLatest(key: string, channel: string, ...args: unknown[]): boolean {
    if (this.send(channel, ...args)) {
      this.latest.delete(key)
      return true
    }
    if (!this.disposed) this.latest.set(key, { channel, args })
    return false
  }

  enqueue(channel: string, ...args: unknown[]): boolean {
    if (this.send(channel, ...args)) return true
    if (!this.disposed) this.queue.push({ channel, args })
    return false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    this.latest.clear()
    this.queue.length = 0
    this.contents.off("did-start-navigation", this.onDidStartNavigation)
    this.contents.off("render-process-gone", this.markUnavailable)
    this.contents.off("destroyed", this.markUnavailable)
  }

  private readonly onDidStartNavigation = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (event.isMainFrame && !event.isSameDocument) this.ready = false
  }

  private readonly markUnavailable = () => {
    this.ready = false
  }

  private flushPending(): void {
    for (const [key, message] of this.latest) {
      if (!this.send(message.channel, ...message.args)) return
      this.latest.delete(key)
    }
    while (this.queue.length) {
      const message = this.queue[0]!
      if (!this.send(message.channel, ...message.args)) return
      this.queue.shift()
    }
  }

  private isCurrentDeliverableFrame(frame: WebFrameMain): boolean {
    const current = this.deliverableFrame()
    return current !== null && this.sameFrame(current, frame)
  }

  private frameUnavailable(frame: WebFrameMain): boolean {
    if (this.disposed || this.contents.isDestroyed() || this.contents.isCrashed()) return true
    try {
      if (frame.isDestroyed() || frame.detached) return true
      return !this.sameFrame(this.contents.mainFrame, frame)
    } catch {
      return true
    }
  }

  private sameFrame(left: WebFrameMain, right: WebFrameMain): boolean {
    try {
      return left.processId === right.processId && left.routingId === right.routingId
    } catch {
      return false
    }
  }

  private deliverableFrame(): WebFrameMain | null {
    if (this.disposed || this.contents.isDestroyed() || this.contents.isCrashed()) return null
    try {
      const frame = this.contents.mainFrame
      if (frame.isDestroyed() || frame.detached) return null
      return frame
    } catch {
      return null
    }
  }
}
