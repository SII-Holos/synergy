const TEXT_DELTA_WINDOW_MS = 16
const TOOL_DELTA_WINDOW_MS = 250
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

  async *batches(source: AsyncIterable<T>): AsyncGenerator<T[]> {
    const iterator = source[Symbol.asyncIterator]()
    let next: Promise<IteratorResult<T>> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    let failed = false
    try {
      while (true) {
        next ??= iterator.next()
        const pending = this.pending
        const delay = pending ? Math.max(0, pending.startedAt + deltaWindow(pending.type) - Date.now()) : undefined
        const result =
          delay === undefined
            ? await next
            : await Promise.race([
                next,
                new Promise<undefined>((resolve) => {
                  timer = setTimeout(() => resolve(undefined), delay)
                }),
              ])
        clearTimeout(timer)
        timer = undefined
        if (!result) {
          yield this.flush()
          continue
        }
        next = undefined
        if (result.done) {
          ended = true
          break
        }
        const events = this.push(result.value)
        if (events.length) yield events
      }
      const events = this.flush()
      if (events.length) yield events
    } catch (error) {
      failed = true
      throw error
    } finally {
      clearTimeout(timer)
      this.pending = undefined
      if (!ended) {
        try {
          await iterator.return?.()
        } catch (error) {
          if (!failed) throw error
        }
      }
    }
  }

  push(event: T, now = Date.now()): T[] {
    const delta = deltaInfo(event)
    if (!delta) return [...this.flush(), event]

    const pending = this.pending
    const withinWindow = pending && now - pending.startedAt < deltaWindow(delta.type)
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

function deltaWindow(type: DeltaInfo["type"]) {
  return type === "tool-input-delta" ? TOOL_DELTA_WINDOW_MS : TEXT_DELTA_WINDOW_MS
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
