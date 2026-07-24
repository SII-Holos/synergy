const TEXT_DELTA_WINDOW_MS = 16
const DELTA_MAX_CHARS = 32 * 1024

type DeltaField = "text" | "delta"

interface DeltaInfo {
  type: "text-delta" | "reasoning-delta" | "tool-input-delta"
  id: string
  field: DeltaField
  chunk: string
}

interface PendingDelta<T> extends DeltaInfo {
  event: T
  chunks: string[]
  chars: number
  startedAt: number
}

export class AgentStreamEventCoalescer<T extends { type: string }> {
  private pending: PendingDelta<T> | undefined

  push(event: T, now = Date.now()): T[] {
    const delta = deltaInfo(event)
    if (!delta) return [...this.flush(), event]

    const pending = this.pending
    const withinWindow =
      delta.type === "tool-input-delta" || (pending && now - pending.startedAt < TEXT_DELTA_WINDOW_MS)
    if (
      pending &&
      pending.type === delta.type &&
      pending.id === delta.id &&
      withinWindow &&
      pending.chars + delta.chunk.length <= DELTA_MAX_CHARS
    ) {
      pending.chunks.push(delta.chunk)
      pending.chars += delta.chunk.length
      return []
    }

    const flushed = this.flush()
    this.pending = {
      ...delta,
      event,
      chunks: [delta.chunk],
      chars: delta.chunk.length,
      startedAt: now,
    }
    return flushed
  }

  flush(): T[] {
    const pending = this.pending
    if (!pending) return []
    this.pending = undefined
    const content = pending.chunks.join("")
    return [
      {
        ...pending.event,
        [pending.field]: content,
      },
    ]
  }
}

function deltaInfo<T extends { type: string }>(event: T): DeltaInfo | undefined {
  const value = event as T & {
    id?: unknown
    text?: unknown
    delta?: unknown
  }
  if (typeof value.id !== "string") return
  if ((value.type === "text-delta" || value.type === "reasoning-delta") && typeof value.text === "string") {
    return {
      type: value.type,
      id: value.id,
      field: "text",
      chunk: value.text,
    }
  }
  if (value.type === "tool-input-delta" && typeof value.delta === "string") {
    return {
      type: value.type,
      id: value.id,
      field: "delta",
      chunk: value.delta,
    }
  }
}
