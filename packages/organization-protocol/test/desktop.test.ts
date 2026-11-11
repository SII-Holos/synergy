import { expect, test } from "bun:test"
import { OrganizationDesktop as Desktop } from "../src/desktop"

test("native binary messages retain bytes and reject ambiguous or unbounded payloads", () => {
  const base = {
    requestID: "request",
    connectionID: "a".repeat(64),
    method: "PUT",
    path: "/org/v1/sessions/session/blobs/" + "b".repeat(64),
  }
  const bytes = new Uint8Array([0, 255, 128, 10])
  expect(
    Desktop.Request.parse({ ...base, bodyBytes: bytes, contentType: "application/octet-stream" }).bodyBytes,
  ).toEqual(bytes)
  for (const extra of [
    { bodyBytes: new Uint8Array(4 * 1024 * 1024 + 1), contentType: "application/octet-stream" },
    { bodyBytes: bytes, contentType: "text/html" },
    { bodyBytes: bytes, body: "{}", contentType: "application/octet-stream" },
    { bodyBytes: bytes.buffer, contentType: "application/octet-stream" },
    { bodyBytes: [0, 255], contentType: "application/octet-stream" },
    { range: "bytes=0-4194304" },
    { range: "bytes=0-3,8-12" },
  ])
    expect(Desktop.Request.safeParse({ ...base, ...extra }).success).toBe(false)
  expect(
    Desktop.Response.parse({
      status: 206,
      bodyBytes: bytes,
      contentType: "application/octet-stream",
      contentRange: "bytes 0-3/10",
    }),
  ).toMatchObject({ bodyBytes: bytes })
  expect(
    Desktop.Response.safeParse({ status: 200, body: "{}", bodyBytes: bytes, contentType: "application/octet-stream" })
      .success,
  ).toBe(false)
})
