import type { CDPSession, Page } from "playwright"
import { cdpCommandTimeoutMs, withCdpCommandTimeout, type CdpTransport } from "@ericsanchezok/synergy-browser"

export class PlaywrightCdpTransport implements CdpTransport {
  private sessionPromise: Promise<CDPSession> | null = null
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private bridges = new Map<string, (params: unknown) => void>()
  private bridgeTasks = new Set<Promise<void>>()
  private bridgeFailures: unknown[] = []

  constructor(private page: Page) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const session = await this.session()
    const command = session.send(method as never, params as never) as Promise<T>
    return withCdpCommandTimeout(command, method, cdpCommandTimeoutMs(method, params))
  }

  on(event: string, listener: (params: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    this.trackBridgeTask(this.installBridge(event))
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  async dispose() {
    await Promise.allSettled(Array.from(this.bridgeTasks))
    let session: CDPSession | null = null
    try {
      session = (await this.sessionPromise) ?? null
    } catch (error) {
      this.bridgeFailures.push(error)
    }
    if (session) {
      for (const [event, bridge] of this.bridges) session.off(event as never, bridge as never)
      try {
        await session.detach()
      } catch (error) {
        this.bridgeFailures.push(error)
      }
    }
    this.listeners.clear()
    this.bridges.clear()
    this.bridgeTasks.clear()
    this.sessionPromise = null
    const failures = this.bridgeFailures.splice(0)
    if (failures.length) throw new AggregateError(failures, "Playwright CDP transport did not dispose cleanly.")
  }

  private session(): Promise<CDPSession> {
    this.sessionPromise ??= this.page.context().newCDPSession(this.page)
    return this.sessionPromise
  }

  private async installBridge(event: string) {
    if (this.bridges.has(event)) return
    const session = await this.session()
    if (this.bridges.has(event)) return
    const bridge = (params: unknown) => {
      for (const listener of this.listeners.get(event) ?? []) listener(params)
    }
    this.bridges.set(event, bridge)
    session.on(event as never, bridge as never)
  }

  private trackBridgeTask(task: Promise<void>): void {
    this.bridgeTasks.add(task)
    void task.catch((error) => this.bridgeFailures.push(error)).finally(() => this.bridgeTasks.delete(task))
  }
}
