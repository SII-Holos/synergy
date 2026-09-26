import { expect, test } from "bun:test"
import { PassThrough, Writable } from "node:stream"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { text } from "node:stream/consumers"
import net from "node:net"
import { setImmediate } from "node:timers/promises"
import { forwardOwnedInput } from "../../src/process/owned-input"

test("input EOF waits for the destination to acknowledge its last bytes", async () => {
  const source = new PassThrough()
  const pending = Promise.withResolvers<void>()
  const received = Promise.withResolvers<void>()
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      received.resolve()
      void pending.promise.then(() => callback())
    },
  })
  const end = forwardOwnedInput(source, destination)
  const finished = once(destination, "finish")
  try {
    end(1024)
    source.write(Buffer.alloc(1024))
    await received.promise
    expect(destination.writableEnded).toBe(false)
    pending.resolve()
    await finished
    expect(destination.writableFinished).toBe(true)
  } finally {
    pending.resolve()
    source.destroy()
    destination.destroy()
  }
})

test("input EOF can arrive after all bytes or before an empty stream", async () => {
  for (const bytes of [0, 64 * 1024 + 13]) {
    const source = new PassThrough()
    let received = 0
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        callback()
      },
    })
    const end = forwardOwnedInput(source, destination)
    const finished = once(destination, "finish")
    source.write(Buffer.alloc(bytes))
    end(bytes)
    await finished
    expect(received).toBe(bytes)
    source.destroy()
  }
})

test("normal source closure preserves queued writes until their acknowledgement", async () => {
  const source = new PassThrough()
  const held = Promise.withResolvers<void>()
  const chunks: Buffer[] = []
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      if (chunks.length === 1) void held.promise.then(() => callback())
      else callback()
    },
  })
  const finished = once(destination, "finish")
  const closed = once(source, "close")
  const end = forwardOwnedInput(source, destination)
  try {
    end(39)
    source.write(Buffer.alloc(13, 1))
    source.write(Buffer.alloc(13, 2))
    source.end(Buffer.alloc(13, 3))
    await closed
    held.resolve()
    await setImmediate()
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.concat([Buffer.alloc(13, 1), Buffer.alloc(13, 2), Buffer.alloc(13, 3)]),
    )
    await finished
  } finally {
    held.resolve()
    source.destroy()
    destination.destroy()
  }
})

test("a rejected write closes input without announcing EOF", async () => {
  const source = new PassThrough()
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("closed pipe"))
    },
  })
  const end = forwardOwnedInput(source, destination)
  const closed = new Promise<void>((resolve) => source.once("close", resolve))
  end(1024)
  source.write(Buffer.alloc(1024))
  await closed
  expect(destination.writableEnded).toBe(false)
  expect(source.destroyed).toBe(true)
})

test.each([0, 64 * 1024 + 13, 1024 * 1024, 16 * 1024 * 1024 + 137])(
  "socket forwarding preserves %i input bytes through child stdin",
  async (size) => {
    const bytes = Buffer.alloc(size)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const hash=new Bun.CryptoHasher('sha256'); let bytes=0; for await (const chunk of Bun.stdin.stream()) {bytes+=chunk.length; hash.update(chunk)}; console.log(JSON.stringify({bytes,sha256:hash.digest('hex')}))",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    const output = text(child.stdout)
    const error = text(child.stderr)
    const exited = once(child, "close")
    let input: net.Socket | undefined
    const server = net.createServer((socket) => {
      input = socket
      forwardOwnedInput(socket, child.stdin)(size)
    })
    let sender: net.Socket | undefined
    try {
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address() as net.AddressInfo
      sender = net.createConnection(address.port, "127.0.0.1")
      await once(sender, "connect")
      for (let offset = 0; offset < bytes.length; offset += 65521) {
        if (!sender.write(bytes.subarray(offset, offset + 65521))) await once(sender, "drain")
      }
      sender.end()
      expect((await exited)[0], await error).toBe(0)
      expect(JSON.parse(await output)).toEqual({
        bytes: size,
        sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
      })
    } finally {
      if (child.exitCode === null) child.kill()
      await exited
      sender?.destroy()
      input?.destroy()
      server.close()
    }
  },
  20000,
)
