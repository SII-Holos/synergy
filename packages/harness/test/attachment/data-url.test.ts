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

for (const url of ["data:broken", "data:text/plain;base64,!", "data:text/plain;base64,a", "file:///fixture"]) {
  test(`rejects malformed inline data without fabricating bytes: ${url}`, () => {
    expect(() => Attachment.decodeDataUrl(url)).toThrow(Attachment.InvalidUrlError)
  })
}
