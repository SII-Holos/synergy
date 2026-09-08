/**
 * Read piped stdin with a short timeout.
 *
 * When stdin is not a TTY but also not a pipe (e.g. programmatic invocation,
 * CI environments), Bun.stdin.text() blocks forever waiting for EOF that never
 * arrives. This function uses a stream-based read with a small grace window:
 * if no data arrives within 50ms the stream is paused and we return empty,
 * otherwise we drain the pipe to completion.
 */
export async function readPipedStdin(): Promise<string> {
  const STREAM_TIMEOUT_MS = 50
  const chunks: Buffer[] = []

  return new Promise<string>((resolve) => {
    const done = once(() => {
      process.stdin.pause()
      resolve(Buffer.concat(chunks).toString("utf8"))
    })

    const timer = setTimeout(done, STREAM_TIMEOUT_MS)

    process.stdin
      .on("data", (chunk: Buffer) => {
        clearTimeout(timer)
        chunks.push(chunk)
      })
      .on("end", () => {
        clearTimeout(timer)
        done()
      })
      .on("error", () => {
        clearTimeout(timer)
        done()
      })
      .resume()
  })
}

/** Ensures `fn` is called at most once. */
export function once<T extends (...args: any[]) => void>(fn: T): T {
  let called = false
  return ((...args: any[]) => {
    if (called) return
    called = true
    fn(...args)
  }) as T
}
