export function captureOutput(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        output = (output + decoder.decode(chunk.value, { stream: true })).slice(-100_000)
      }
    } finally {
      reader.releaseLock()
    }
  })().catch(() => undefined)
  return { done, text: () => output, cancel: () => void reader.cancel().catch(() => undefined) }
}
