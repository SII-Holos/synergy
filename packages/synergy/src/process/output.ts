export namespace ProcessOutput {
  export type LimitReason = "max_record_bytes" | "max_output_bytes"

  export class LimitError extends Error {
    constructor(
      readonly reason: LimitReason,
      readonly limitBytes: number,
    ) {
      super(
        `Process output exceeded ${reason === "max_record_bytes" ? "record" : "total"} limit of ${limitBytes} bytes`,
      )
      this.name = "ProcessOutputLimitError"
    }
  }

  export async function* lines(
    stream: ReadableStream<Uint8Array>,
    options: {
      maxRecordBytes?: number
      maxOutputBytes?: number
      signal?: AbortSignal
    } = {},
  ): AsyncGenerator<string> {
    const maxRecordBytes = options.maxRecordBytes ?? 256 * 1024
    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    let pendingBytes = 0
    let totalBytes = 0
    let reachedEnd = false

    const onAbort = () => void reader.cancel(options.signal?.reason).catch(() => {})
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    const throwIfAborted = () => {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError")
    }

    try {
      while (true) {
        throwIfAborted()
        const { done, value } = await reader.read()
        throwIfAborted()
        if (done) {
          throwIfAborted()
          reachedEnd = true
          break
        }

        const remaining = maxOutputBytes - totalBytes
        const accepted = value.subarray(0, Math.max(0, remaining))
        const outputLimited = accepted.length < value.length
        totalBytes += accepted.length

        let offset = 0
        while (offset < accepted.length) {
          throwIfAborted()
          const newline = accepted.indexOf(0x0a, offset)
          const end = newline === -1 ? accepted.length : newline + 1
          const segment = accepted.subarray(offset, end)
          const contentBytes = segment.length - (newline === -1 ? 0 : 1)
          if (pendingBytes + contentBytes > maxRecordBytes) {
            throw new LimitError("max_record_bytes", maxRecordBytes)
          }
          pendingBytes += contentBytes
          pending += decoder.decode(segment, { stream: true })
          if (newline !== -1) {
            const raw = pending.slice(0, -1)
            throwIfAborted()
            yield raw.endsWith("\r") ? raw.slice(0, -1) : raw
            pending = ""
            pendingBytes = 0
          }
          offset = end
        }

        if (outputLimited) throw new LimitError("max_output_bytes", maxOutputBytes)
      }

      pending += decoder.decode()
      throwIfAborted()
      if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
      if (!reachedEnd) await reader.cancel().catch(() => {})
      try {
        reader.releaseLock()
      } catch {}
    }
  }

  export async function drainText(
    stream: ReadableStream<Uint8Array>,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; truncated: boolean }> {
    const maxBytes = options.maxBytes ?? 64 * 1024
    const reader = stream.getReader()
    const retained: Uint8Array[] = []
    let retainedBytes = 0
    let truncated = false

    const onAbort = () => void reader.cancel(options.signal?.reason).catch(() => {})
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    try {
      while (true) {
        if (options.signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        const remaining = maxBytes - retainedBytes
        if (remaining > 0) {
          const accepted = value.subarray(0, remaining)
          retained.push(accepted.slice())
          retainedBytes += accepted.length
        }
        if (value.length > remaining) truncated = true
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
      try {
        reader.releaseLock()
      } catch {}
    }

    const joined = new Uint8Array(retainedBytes)
    let offset = 0
    for (const chunk of retained) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    return { text: new TextDecoder().decode(joined), truncated }
  }

  type BunProcess = ReturnType<typeof Bun.spawn>
  const TERMINATE_GRACE_MS = 500
  const TERMINATE_HARD_WAIT_MS = 1_000

  async function waitExited(proc: BunProcess, timeoutMs: number) {
    return Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      Bun.sleep(timeoutMs).then(() => false),
    ])
  }

  export async function terminate(proc: BunProcess): Promise<boolean> {
    proc.kill()
    if (await waitExited(proc, TERMINATE_GRACE_MS)) return true

    if (process.platform === "win32" && proc.pid) {
      const killer = Bun.spawn(["taskkill", "/pid", String(proc.pid), "/f", "/t"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      await Promise.race([killer.exited.catch(() => undefined), Bun.sleep(TERMINATE_HARD_WAIT_MS)])
    } else {
      proc.kill("SIGKILL")
    }
    return await waitExited(proc, TERMINATE_HARD_WAIT_MS)
  }
}
