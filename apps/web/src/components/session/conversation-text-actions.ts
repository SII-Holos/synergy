export function createConversationTextActions(input: {
  selection: () => { sessionID?: string; title?: string }
  read: (sessionID: string) => Promise<string>
  copy: (text: string) => Promise<boolean>
  download: (text: string, filename: string) => void
}) {
  const pending = new Map<string, Promise<string>>()
  const read = (sessionID: string) => {
    const existing = pending.get(sessionID)
    if (existing) return existing
    const request = input.read(sessionID).finally(() => {
      if (pending.get(sessionID) === request) pending.delete(sessionID)
    })
    pending.set(sessionID, request)
    return request
  }
  return {
    async copy() {
      const { sessionID } = input.selection()
      if (!sessionID) return false
      const text = await read(sessionID)
      return text ? input.copy(text) : false
    },
    async export() {
      const { sessionID, title } = input.selection()
      if (!sessionID) return false
      const filename = (title?.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "conversation") + ".txt"
      const text = await read(sessionID)
      if (!text) return false
      input.download(text, filename)
      return true
    },
  }
}
