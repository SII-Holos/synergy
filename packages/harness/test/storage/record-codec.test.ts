import { expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import { RecordCodec, type RecordBody } from "../../src/storage/record-codec"

function asString(body: RecordBody) {
  return typeof body === "string" ? body : undefined
}

test("a body below the compression floor stays plain JSON with no frame overhead", () => {
  for (const value of [null, false, 0, "z:literal", { optional: { unknown: true } }, { small: "你好 🌍" }]) {
    const body = RecordCodec.encode(value)
    expect(RecordCodec.decode<typeof value>(body)).toEqual(value)
    // Below the floor a frame header would cost more than it saves, so the body
    // is plain JSON that any earlier reader can still parse.
    expect(asString(body)).toBe(JSON.stringify(value))
  }
})

test("a repetitive body above the floor round-trips through the current frame form", () => {
  const value = { optional: { unknown: true }, text: "你好 🌍".repeat(2000) }
  const body = RecordCodec.encode(value)
  expect(RecordCodec.decode<typeof value>(body)).toEqual(value)
  expect(body).toBeInstanceOf(Uint8Array)
})

test("a compressible body is stored as a frame and round-trips exactly", () => {
  const value = { text: "durable evidence".repeat(2000) }
  const body = RecordCodec.encode(value)
  // The current form is a blob whose frame header carries the codec and the
  // declared decoded length; the encoded JSON string form is only produced when
  // a frame would not actually be smaller.
  expect(body).toBeInstanceOf(Uint8Array)
  const frame = body as Uint8Array
  expect(frame[0]).toBe(0x1a)
  expect(frame.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(value)))
  expect(RecordCodec.decode<typeof value>(body)).toEqual(value)
})

test("the retired z: base64 deflate form stays readable", () => {
  const value = { legacy: "x".repeat(4096) }
  const legacy = "z:" + deflateSync(JSON.stringify(value), { level: 1 }).toString("base64")
  expect(RecordCodec.decode<typeof value>(legacy)).toEqual(value)
  // Plain JSON without the prefix decodes too: that is what an unrewritten row
  // and a migration in progress still hold.
  expect(RecordCodec.decode<typeof value>(JSON.stringify(value))).toEqual(value)
})

test("corrupt bodies fail with an integrity error instead of returning wrong data", () => {
  const encoded = RecordCodec.encode({ text: "durable evidence".repeat(2000) }) as Uint8Array
  expect(() => RecordCodec.decode(encoded.slice(0, encoded.byteLength - 4))).toThrow(
    "Stored record encoding is invalid",
  )
  expect(() => RecordCodec.decode("z:!!!!")).toThrow("Stored record encoding is invalid")
  expect(() => RecordCodec.encode(undefined)).toThrow()
  // A frame whose marker is wrong, whose codec is unknown, or whose declared
  // length disagrees with the payload must all be rejected rather than
  // decompressed on trust.
  expect(() => RecordCodec.decode(new Uint8Array([0x00, 1, 3, 1, 2, 3]))).toThrow("Stored record encoding is invalid")
  expect(() => RecordCodec.decode(new Uint8Array([0x1a, 9, 3, 1, 2, 3]))).toThrow("Stored record encoding is invalid")
  expect(() => RecordCodec.decode(new Uint8Array([0x1a, 0, 99, 1, 2, 3]))).toThrow("Stored record encoding is invalid")
})

test("a declared length beyond the expansion limit is rejected before any work", () => {
  // A header that claims a size past the cap must fail on the header alone, so a
  // small body cannot ask the decoder to allocate an arbitrarily large buffer.
  const oversized = Buffer.concat([
    Buffer.from([0x1a, 0]),
    Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10]),
    Buffer.from([1, 2, 3]),
  ])
  expect(() => RecordCodec.decode(oversized)).toThrow("Stored record encoding is invalid")
})

test("the text container keeps a body representable in a TEXT column", () => {
  // A byte frame is only storable where the body column is a blob: a `TEXT`
  // column renders those bytes as hex text, and no reader accepts that. A
  // namespace whose body column is `TEXT` therefore writes the text container,
  // and what it writes has to be a form its own readers already parse.
  const value = { text: "durable evidence".repeat(2000) }
  const text = RecordCodec.encode(value, "text")
  expect(typeof text).toBe("string")
  expect(RecordCodec.decode<typeof value>(text)).toEqual(value)

  const framed = RecordCodec.encode(value, "frame")
  expect(framed).toBeInstanceOf(Uint8Array)
  // The container changes the form, never the value.
  expect(RecordCodec.decode<typeof value>(framed)).toEqual(value)
})

test("a body below the floor stays plain text in either container", () => {
  // Below the floor neither container may add bytes the column would store: the
  // text container writes JSON text and the frame container writes the same JSON
  // string rather than a frame header.
  expect(RecordCodec.encode({ v: 1 }, "text")).toBe('{"v":1}')
  expect(RecordCodec.encode({ v: 1 }, "frame")).toBe('{"v":1}')
})

test("re-encoding targets the container its caller names", () => {
  // The format 3 rewrite moves bodies into a blob column, while a rewrite that
  // has not run yet must leave them in the text column they came from.
  const value = { legacy: "x".repeat(4096) }
  const legacy = "z:" + deflateSync(JSON.stringify(value), { level: 1 }).toString("base64")
  const asText = RecordCodec.reencode(legacy, "text")
  const asFrame = RecordCodec.reencode(legacy, "frame")
  expect(typeof asText).toBe("string")
  expect(asFrame).toBeInstanceOf(Uint8Array)
  expect(RecordCodec.decode<typeof value>(asText)).toEqual(value)
  expect(RecordCodec.decode<typeof value>(asFrame)).toEqual(value)
})

test("an incompressible body is stored plainly rather than growing", () => {
  const value = { random: crypto.randomUUID().repeat(40) }
  const body = RecordCodec.encode(value)
  const json = JSON.stringify(value)
  if (body instanceof Uint8Array) expect(body.byteLength).toBeLessThan(Buffer.byteLength(json))
  else expect(body).toBe(json)
  expect(RecordCodec.decode<typeof value>(body)).toEqual(value)
})

test("a body at or beyond the expansion ceiling stays plain JSON", () => {
  const value = { text: "x".repeat(128 * 1024 * 1024) }
  const encoded = RecordCodec.encode(value)
  // The ceiling is a guard against a single record dominating the worker, so a
  // body past it is never handed to the codec at all.
  expect(typeof encoded).toBe("string")
  expect(RecordCodec.decode<typeof value>(encoded).text).toBe(value.text)
})
