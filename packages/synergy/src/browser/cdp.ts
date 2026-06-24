import type { Page } from "playwright"

export interface CDPHandle {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on<T = unknown>(event: string, handler: (params: T) => void): () => void
  detach(): Promise<void>
}

export namespace BrowserCDP {
  export async function attach(page: Page): Promise<CDPHandle> {
    const session = (await page.context().newCDPSession(page)) as any
    return {
      send(method, params) {
        return session.send(method, params) as Promise<unknown> as Promise<any>
      },
      on(event, handler) {
        const typed = handler as (...args: any[]) => void
        session.on(event, typed)
        return () => session.off(event, typed)
      },
      async detach() {
        await session.detach()
      },
    }
  }
}
