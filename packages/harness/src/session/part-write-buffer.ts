import { StorageBusyError, StorageConflictError } from "../storage/errors"
import type { MessageV2 } from "./message-v2"
import { PartContent } from "./part-content"

type Owner = Pick<MessageV2.Part, "id" | "messageID" | "sessionID">
type Entry = {
  bytes: number
  replaces: boolean
  write(guard: () => void): Promise<void>
}
type Pending = {
  path: string[]
  header: PartContent.Header
  chunks: string[]
  checkpoint: PartContent.Checkpoint
  offset: number
  bytes: number
}
type Stream = {
  path: string[]
  owner: Owner
  summary?: PartContent.Stream
  accepted: number
  fence: number
  replacing?: boolean
  pending?: Pending
  failure?: { entry: Entry; error: unknown }
  running?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

export class PartWriteBuffer {
  private bytes = 0
  private readonly streams = new Map<string, Stream>()

  constructor(
    private readonly write: (path: string[], batch: PartContent.Batch, guard: () => void) => Promise<void>,
    private readonly intervalMs = 500,
  ) {}

  defer(key: string, path: string[], part: PartContent.Streaming, delta: string) {
    const previous = this.streams.get(key)
    if (previous?.failure?.entry.replaces) throw previous.failure.error
    if (previous?.replacing) throw new StorageConflictError("Streaming Part is being replaced")
    const text = previous ? delta : part.text
    if (previous && part.text.length !== previous.accepted + delta.length)
      throw new StorageConflictError("Streaming Part delta does not match its accepted offset")
    const { text: _, ...metadata } = part
    const header = structuredClone(metadata)
    const bytes = text.length * 2 + Buffer.byteLength(JSON.stringify(header))
    this.admit(key, bytes)
    const stream = previous ?? this.create(key, path, part)
    stream.summary ??= new PartContent.Stream()
    const checkpoint = stream.summary.append(header, text)
    const pending = stream.pending ?? { path, header, chunks: [], checkpoint, offset: stream.accepted, bytes: 0 }
    pending.chunks.push(text)
    pending.header = header
    pending.checkpoint = checkpoint
    pending.bytes += bytes
    stream.pending = pending
    stream.accepted += text.length
    this.bytes += bytes
    if (!stream.timer) {
      stream.timer = setTimeout(() => {
        stream.timer = undefined
        void this.flush(key).catch(() => {})
      }, this.intervalMs)
      stream.timer.unref()
    }
    return stream.summary.summary(header, checkpoint)
  }

  flush(key: string): Promise<void> {
    const stream = this.streams.get(key)
    if (!stream) return Promise.resolve()
    if (stream.running) return stream.running.then(() => this.flush(key))
    clearTimeout(stream.timer)
    stream.timer = undefined
    let entry = stream.failure?.entry
    const pending = stream.pending
    if (!entry && pending) {
      const batch: PartContent.Batch = {
        header: pending.header,
        text: pending.chunks.join(""),
        offset: pending.offset,
        checkpoint: pending.checkpoint,
        operationID: crypto.randomUUID(),
      }
      entry = { bytes: pending.bytes, replaces: false, write: (guard) => this.write(pending.path, batch, guard) }
      stream.pending = undefined
    }
    if (!entry) return Promise.resolve()
    stream.failure = undefined
    return this.execute(key, stream, entry).then(() => (stream.pending ? this.flush(key) : undefined))
  }

  writeNow(
    key: string,
    path: string[],
    value: MessageV2.Part,
    write: (path: string[], part: MessageV2.Part, guard: () => void) => Promise<void>,
  ): Promise<void> {
    const snapshot = structuredClone(value)
    const bytes = Buffer.byteLength(JSON.stringify(snapshot))
    const previous = this.streams.get(key)
    const replaced = (previous?.pending?.bytes ?? 0) + (previous?.failure?.entry.bytes ?? 0)
    try {
      this.admit(key, bytes - replaced)
    } catch (error) {
      return Promise.reject(error)
    }
    const stream = previous ?? this.create(key, path, value)
    clearTimeout(stream.timer)
    stream.timer = undefined
    stream.pending = undefined
    stream.failure = undefined
    stream.replacing = true
    this.bytes += bytes - replaced
    return this.execute(key, stream, {
      bytes,
      replaces: true,
      write: (guard) => write(path, snapshot, guard),
    })
  }

  private execute(key: string, stream: Stream, entry: Entry): Promise<void> {
    const fence = stream.fence
    const current = () => this.streams.get(key) === stream && stream.fence === fence
    const guard = () => {
      if (!current()) throw new StorageConflictError("Streaming Part write was cancelled")
    }
    const previous = stream.running
    const promise = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => {
        guard()
        return entry.write(guard)
      })
      .then(
        () => {
          this.bytes -= entry.bytes
          if (stream.running !== promise) return
          stream.running = undefined
          if (entry.replaces && current()) this.cancel(key)
        },
        (error: unknown) => {
          const latest = stream.running === promise
          if (latest) stream.running = undefined
          if (latest && current()) stream.failure = { entry, error }
          else this.bytes -= entry.bytes
          throw error
        },
      )
    stream.running = promise
    void promise.catch(() => {})
    return promise
  }

  flushAll() {
    return this.flushWhere(() => true)
  }

  async flushWhere(predicate: (part: Owner, path: string[]) => boolean) {
    const results = await Promise.allSettled(
      [...this.streams].flatMap(([key, stream]) => (predicate(stream.owner, stream.path) ? [this.flush(key)] : [])),
    )
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Part persistence failed")
  }

  assertDrained(key: string) {
    const stream = this.streams.get(key)
    if (stream?.pending || stream?.running || stream?.failure)
      throw new StorageBusyError("Drain streaming part writes before entering a business transaction")
  }

  cancelWhere(predicate: (part: Owner, path: string[]) => boolean) {
    for (const [key, stream] of this.streams) if (predicate(stream.owner, stream.path)) this.cancel(key)
  }

  cancel(key: string) {
    const stream = this.streams.get(key)
    if (!stream) return
    clearTimeout(stream.timer)
    stream.fence++
    this.bytes -= (stream.pending?.bytes ?? 0) + (stream.failure?.entry.bytes ?? 0)
    stream.pending = undefined
    stream.failure = undefined
    this.streams.delete(key)
  }

  private create(key: string, path: string[], part: Owner): Stream {
    const stream: Stream = {
      path,
      owner: { id: part.id, sessionID: part.sessionID, messageID: part.messageID },
      accepted: 0,
      fence: 0,
    }
    this.streams.set(key, stream)
    return stream
  }

  private admit(key: string, bytes: number) {
    if ((!this.streams.has(key) && this.streams.size >= 1024) || this.bytes + bytes > 64 * 1024 * 1024)
      throw new StorageBusyError("Streaming persistence buffer is full; drain before accepting more output")
  }
}
