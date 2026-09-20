import { deflateSync, inflateSync } from "node:zlib"
import { StorageIntegrityError } from "./errors"

/**
 * On-disk form of a stored record body.
 *
 * The column that holds it has no affinity, so a plain JSON string and a
 * compressed blob coexist in the same table and every version of this format
 * stays readable forever. Three forms exist:
 *
 * - `string` without a `z:` prefix: plain JSON.
 * - `string` with a `z:` prefix: the retired base64 deflate form. Kept readable
 *   so a store that has not been rewritten yet, and any migration in progress,
 *   still decodes.
 * - `Uint8Array` starting with `CODEC_MARKER`: the current form. Its header
 *   carries the codec and the declared decoded length, which is what bounds
 *   decompression without trusting the payload.
 *
 * Every form is written by exactly one version, so nothing has to guess: a
 * reader that accepts all three is correct, and a writer that emits only the
 * current one is too.
 */
export type RecordBody = string | Uint8Array

export namespace RecordCodec {
  const CODEC_MARKER = 0x1a
  const CODEC_RAW = 0
  const CODEC_ZSTD = 1
  // Below this a frame header costs more than the compression saves, so the
  // body stays plain JSON. It is deliberately far under the retired 512-byte
  // floor, which skipped most rollout bodies entirely.
  const COMPRESSION_FLOOR = 64
  export const MAX_BODY_BYTES = 128 * 1024 * 1024
  const ZSTD_LEVEL = 3

  // The honest comparison: the frame is stored only when it is actually
  // smaller than the JSON it replaces. The retired codec compared a base64
  // expansion against the original, so a body had to beat an inflated target to
  // be stored compressed at all.
  function frame(json: string): RecordBody {
    const raw = Buffer.from(json, "utf8")
    if (raw.byteLength < COMPRESSION_FLOOR || raw.byteLength > MAX_BODY_BYTES) return json
    const compressed = Buffer.from(Bun.zstdCompressSync(raw, { level: ZSTD_LEVEL }))
    const body = Buffer.concat([Buffer.from([CODEC_MARKER, CODEC_ZSTD]), writeVarint(raw.byteLength), compressed])
    return body.byteLength < raw.byteLength ? body : json
  }

  export function encode(value: unknown): RecordBody {
    const json = JSON.stringify(value)
    if (json === undefined) throw new StorageIntegrityError("A storage record must be JSON serializable")
    return frame(json)
  }

  /**
   * Moves an already-stored body into the current frame form when that is
   * smaller.
   *
   * This deliberately does not decode and re-encode through `JSON`: a stored
   * body is JSON *text*, and a parse/serialize round trip is not byte-preserving
   * for every value a caller may have written (`1e21`, duplicate keys, number
   * precision). A rewrite that changed the recorded bytes would rewrite stored
   * evidence. Only the container changes here; the text is carried across
   * exactly.
   */
  export function reencode(body: RecordBody): RecordBody {
    return frame(text(body))
  }

  /** The JSON text a stored body holds, without parsing it. */
  export function text(body: RecordBody): string {
    try {
      if (typeof body === "string") {
        if (!body.startsWith("z:")) return body
        const encoded = body.slice(2)
        const bytes = Buffer.from(encoded, "base64")
        if (bytes.toString("base64") !== encoded) throw new Error("Invalid record encoding")
        return inflateSync(bytes, { maxOutputLength: MAX_BODY_BYTES }).toString("utf8")
      }
      return frameText(body)
    } catch {
      throw new StorageIntegrityError("Stored record encoding is invalid")
    }
  }

  export function decode<T = unknown>(body: RecordBody): T {
    try {
      if (typeof body === "string") {
        if (!body.startsWith("z:")) return JSON.parse(body) as T
        return decodeLegacy(body) as T
      }
      return decodeFrame(body) as T
    } catch {
      throw new StorageIntegrityError("Stored record encoding is invalid")
    }
  }

  /** The retired base64 deflate form. Readable for as long as any row holds it. */
  function decodeLegacy(body: string) {
    const encoded = body.slice(2)
    const bytes = Buffer.from(encoded, "base64")
    if (bytes.toString("base64") !== encoded) throw new Error("Invalid record encoding")
    return JSON.parse(inflateSync(bytes, { maxOutputLength: MAX_BODY_BYTES }).toString("utf8")) as unknown
  }

  function frameText(body: Uint8Array) {
    if (body.byteLength < 3 || body[0] !== CODEC_MARKER) throw new Error("Invalid record frame")
    const codec = body[1]!
    const [declared, start] = readVarint(body, 2)
    // The declared length is the hard bound. It is checked before any work and
    // again against the result, so a malformed header cannot make the decoder
    // allocate past this limit.
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES)
      throw new Error("Invalid record length")
    const payload = body.subarray(start)
    let raw: Buffer
    if (codec === CODEC_ZSTD) raw = Buffer.from(Bun.zstdDecompressSync(payload))
    else if (codec === CODEC_RAW) raw = Buffer.from(payload)
    else throw new Error("Unknown record codec")
    if (raw.byteLength !== declared) throw new Error("Stored record length disagrees with its header")
    return raw.toString("utf8")
  }

  function decodeFrame(body: Uint8Array) {
    return JSON.parse(frameText(body)) as unknown
  }

  function writeVarint(value: number): Buffer {
    const bytes: number[] = []
    let remaining = value
    do {
      const byte = remaining % 128
      remaining = Math.floor(remaining / 128)
      bytes.push(remaining > 0 ? byte | 0x80 : byte)
    } while (remaining > 0)
    return Buffer.from(bytes)
  }

  function readVarint(body: Uint8Array, offset: number): [number, number] {
    let value = 0
    let shift = 1
    let index = offset
    for (; index < body.byteLength && index - offset < 5; index++) {
      const byte = body[index]!
      value += (byte & 0x7f) * shift
      if ((byte & 0x80) === 0) return [value, index + 1]
      shift *= 128
    }
    throw new Error("Invalid record length prefix")
  }
}
