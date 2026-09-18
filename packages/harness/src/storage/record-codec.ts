import { deflateSync, inflateSync } from "node:zlib"
import { StorageIntegrityError } from "./errors"

export namespace RecordCodec {
  export function encode(value: unknown): string {
    const json = JSON.stringify(value)
    if (json === undefined) throw new StorageIntegrityError("A storage record must be JSON serializable")
    const bytes = Buffer.byteLength(json)
    if (bytes < 512 || bytes > 128 * 1024 * 1024) return json
    const compressed = "z:" + deflateSync(json, { level: 1 }).toString("base64")
    return compressed.length < bytes * 0.9 ? compressed : json
  }

  export function decode<T = unknown>(body: string): T {
    try {
      if (!body.startsWith("z:")) return JSON.parse(body) as T
      const encoded = body.slice(2)
      const bytes = Buffer.from(encoded, "base64")
      if (bytes.toString("base64") !== encoded) throw new Error("Invalid record encoding")
      return JSON.parse(inflateSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }).toString("utf8")) as T
    } catch {
      throw new StorageIntegrityError("Stored record encoding is invalid")
    }
  }
}
