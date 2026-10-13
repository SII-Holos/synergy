import type { SessionDisplayManifest, SessionDisplayManifestInput } from "@ericsanchezok/synergy-sdk/client"

export async function validateDisplayManifest(input: {
  messages: SessionDisplayManifestInput["messages"]
  signal: AbortSignal
  current(): boolean
  read(messages: SessionDisplayManifestInput["messages"]): Promise<SessionDisplayManifest>
  accept(
    message: SessionDisplayManifest["messages"][number],
    previous: SessionDisplayManifestInput["messages"][number],
  ): Promise<void>
}) {
  for (let offset = 0; offset < input.messages.length; offset += 100) {
    input.signal.throwIfAborted()
    if (!input.current()) return false
    const batch = input.messages.slice(offset, offset + 100)
    const response = await input.read(batch)
    input.signal.throwIfAborted()
    if (!input.current()) return false
    const results = new Map(response.messages.map((message) => [message.messageID, message]))
    if (results.size !== batch.length || batch.some((message) => !results.has(message.messageID)))
      throw new Error("Incomplete display manifest")
    for (const previous of batch) {
      if (!input.current()) return false
      await input.accept(results.get(previous.messageID)!, previous)
    }
  }
  return input.current()
}
