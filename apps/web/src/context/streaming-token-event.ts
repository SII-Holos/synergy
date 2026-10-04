export type StreamingTokenPart = {
  id: string
  sessionID?: string
  messageID?: string
  type?: string
}

export type StreamingTokenReceipt = {
  part: StreamingTokenPart
  delta: string
}

type StreamingEvent = {
  type: string
  properties?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function streamingTokenReceipt(event: StreamingEvent): StreamingTokenReceipt | undefined {
  if (!isRecord(event.properties)) return
  if (event.type === "message.part.summary") {
    const { summary, content } = event.properties
    if (!isRecord(summary) || typeof summary.id !== "string" || !isRecord(content)) return
    const delta = content.kind === "delta" ? content.delta : event.properties.delta
    if (typeof delta !== "string") return
    return {
      part: {
        id: summary.id,
        sessionID: typeof summary.sessionID === "string" ? summary.sessionID : undefined,
        messageID: typeof summary.messageID === "string" ? summary.messageID : undefined,
        type: typeof summary.type === "string" ? summary.type : undefined,
      },
      delta,
    }
  }

  if (event.type === "message.part.delta") {
    const { partID, sessionID, messageID, kind, delta } = event.properties
    if (
      typeof partID !== "string" ||
      typeof sessionID !== "string" ||
      typeof messageID !== "string" ||
      typeof kind !== "string" ||
      typeof delta !== "string"
    ) {
      return
    }
    return {
      part: { id: partID, sessionID, messageID, type: kind },
      delta,
    }
  }

  if (event.type !== "message.part.updated") return
  const { part, delta } = event.properties
  if (!isRecord(part) || typeof part.id !== "string" || typeof delta !== "string") return
  return {
    part: {
      id: part.id,
      sessionID: typeof part.sessionID === "string" ? part.sessionID : undefined,
      messageID: typeof part.messageID === "string" ? part.messageID : undefined,
      type: typeof part.type === "string" ? part.type : undefined,
    },
    delta,
  }
}
