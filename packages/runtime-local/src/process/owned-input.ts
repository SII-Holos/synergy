import { Writable, type Readable } from "node:stream"

export function forwardOwnedInput(source: Readable, destination: Writable) {
  let written = 0
  let expected: number | undefined
  const finish = () => {
    if (expected === written && !destination.destroyed && !destination.writableEnded) destination.end()
  }
  // Bun's child stdin fast path bypasses Writable's pending-write accounting; acknowledge writes before EOF.
  // Provenance: https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/internal/fs/streams.ts#L637
  const sink = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, encoding, callback) {
      destination.write(chunk, encoding, (error) => {
        if (!error) written += chunk.length
        callback(error)
        if (!error) finish()
      })
    },
  })
  const stop = () => {
    source.unpipe(sink)
    source.destroy()
    sink.destroy()
  }
  destination.once("error", stop)
  destination.once("close", stop)
  sink.once("error", stop)
  source.once("close", () => {
    if (!source.readableEnded) sink.destroy()
  })
  source.pipe(sink, { end: false })
  return (bytes: number) => {
    expected = bytes
    finish()
  }
}
