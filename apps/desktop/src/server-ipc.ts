import type { IpcMainInvokeEvent, WebContents } from "electron"

export function trustedServerFrame(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  contents: WebContents | undefined,
  appURL: string | null,
  recoveryURL: string | null,
): boolean {
  if (!contents || event.sender !== contents || contents.isDestroyed()) return false
  try {
    const frame = event.senderFrame
    if (!frame || frame.detached || frame.isDestroyed()) return false
    if (frame.processId !== contents.mainFrame.processId || frame.routingId !== contents.mainFrame.routingId)
      return false
    if (recoveryURL && frame.url === recoveryURL) return true
    return Boolean(appURL && new URL(frame.url).origin === new URL(appURL).origin)
  } catch {
    return false
  }
}

export class DesktopServerActions {
  private running?: { action: string; result: Promise<unknown> }

  async settle() {
    await this.running?.result.catch(() => {})
  }

  run<T>(action: string, operation: () => Promise<T>): Promise<T> {
    if (this.running) {
      if (this.running.action !== action) return Promise.reject(new Error("Another server action is in progress"))
      return this.running.result as Promise<T>
    }
    const result = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.running?.result === result) this.running = undefined
      })
    this.running = { action, result }
    return result
  }
}
