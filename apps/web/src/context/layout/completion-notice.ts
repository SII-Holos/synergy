type Notice = { unread: boolean; unreadCount: number }

export function createCompletionNoticeClearer(input: {
  server: () => string
  read: (scope: string, sessionID: string) => Notice | undefined
  write: (scope: string, sessionID: string, notice: Notice) => void
  ready: (sessionID: string) => Promise<boolean>
  update: (scope: string, sessionID: string) => Promise<unknown>
  failed: (error: unknown) => void
}) {
  const pending = new Set<string>()
  return async (scope: string, sessionID: string) => {
    const notice = input.read(scope, sessionID)
    const server = input.server()
    const key = JSON.stringify([server, scope, sessionID])
    if (!notice?.unread || pending.has(key)) return
    pending.add(key)
    let optimistic = false
    try {
      if (!(await input.ready(sessionID)) || input.server() !== server) return
      optimistic = true
      input.write(scope, sessionID, { unread: false, unreadCount: 0 })
      await input.update(scope, sessionID)
    } catch (error) {
      input.failed(error)
      if (optimistic && input.server() === server) input.write(scope, sessionID, notice)
    } finally {
      pending.delete(key)
    }
  }
}
