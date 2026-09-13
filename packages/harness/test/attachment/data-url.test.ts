import { expect, test } from "bun:test"
import { Attachment } from "../../src/attachment"

for (const [url, bytes, mime] of [
  ["data:text/plain;base64,aGVsbG8=", Buffer.from("hello"), "text/plain"],
  ["data:text/plain;charset=utf-8,hello%20%E4%B8%96%E7%95%8C+%25", Buffer.from("hello 世界+%"), "text/plain"],
  ["data:application/octet-stream,%00%FF%80", Buffer.from([0, 255, 128]), "application/octet-stream"],
  ["data:;BASE64,YQ%3D%3D", Buffer.from("a"), "text/plain"],
  ["data:,", Buffer.alloc(0), "text/plain"],
] as const) {
  test(`decodes inline attachment bytes: ${url}`, () => {
    expect(Attachment.decodeDataUrl(url)).toEqual({ mime, buffer: bytes })
  })
}
// Producers built data URLs with a URL-safe base64 helper while labeling them
// standard base64 (regression behind stranded inbox items); forgiving-base64
// decoding accepts those legacy payloads instead of stranding them.
for (const [url, bytes] of [
  ["data:text/plain;base64,8J-agA", Buffer.from("🚀")],
  ["data:text/plain;base64,-_8", Buffer.from([0xfb, 0xff])],
  ["data:text/plain;base64,aGVsbG8", Buffer.from("hello")],
  ["data:text/plain;base64,YQ", Buffer.from("a")],
] as const) {
  test(`accepts legacy URL-safe and unpadded base64 payloads: ${url}`, () => {
    expect(Attachment.decodeDataUrl(url).buffer).toEqual(bytes)
  })
}

for (const url of [
  "data:broken",
  "data:text/plain;base64,!",
  "data:text/plain;base64,a",
  "data:text/plain;base64,====",
  "data:text/plain;base64,==",
  "data:text/plain;base64,a=b",
  "file:///fixture",
]) {
  test(`rejects malformed inline data without fabricating bytes: ${url}`, () => {
    expect(() => Attachment.decodeDataUrl(url)).toThrow(Attachment.InvalidUrlError)
  })
}
