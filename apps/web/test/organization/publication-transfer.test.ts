import { expect, test } from "bun:test"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { uploadPublication, streamPublicationDownload } from "../../src/organization/publication-transfer"

test("publication bytes are hashed and uploaded through bounded generated SDK chunks", async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 19).fill(0xfe)
  const writes: number[] = []
  let declaration: Record<string, unknown> = {}
  const api = createOrganizationClient({
    baseUrl: "https://org.example",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname.endsWith("/chunks")) {
          const body = new Uint8Array(await request.arrayBuffer())
          expect(body[0]).toBe(0xfe)
          writes.push(body.length)
          return Response.json({ receivedBytes: Number(url.searchParams.get("offset")) + body.length })
        }
        if (url.pathname.endsWith("/files")) {
          declaration = await request.json()
          return Response.json({ ...declaration, fileID: "a".repeat(64) })
        }
        return Response.json({
          uploadID: "upload-one",
          state: url.pathname.endsWith("/seal") ? "sealed" : "open",
          manifestHash: "b".repeat(64),
        })
      },
      { preconnect() {} },
    ),
  })
  const result = await uploadPublication(api, {
    requestID: "request-one",
    purpose: "knowledge",
    scope: { kind: "organization" },
    files: [{ path: "reference.bin", blob: new Blob([bytes]) }],
    signal: new AbortController().signal,
  })
  expect(declaration.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
  expect(writes).toEqual([4 * 1024 * 1024, 19])
  expect(result.uploadID).toBe("upload-one")
})

test("download streams bounded exact ranges and verifies integrity before completion", async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 2).fill(0xff)
  const ranges: string[] = []
  const lengths: number[] = []
  const file = { bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }
  await streamPublicationDownload({
    file,
    signal: new AbortController().signal,
    async read(start, end) {
      ranges.push(`${start}-${end}`)
      return { bytes: bytes.slice(start, end + 1), status: 206, contentRange: `bytes ${start}-${end}/${bytes.length}` }
    },
    async append(value) {
      lengths.push(value.length)
    },
  })
  expect(ranges).toEqual(["0-4194303", "4194304-4194305"])
  expect(lengths).toEqual([4194304, 2])
  await expect(
    streamPublicationDownload({
      file,
      signal: new AbortController().signal,
      async read(start, end) {
        return {
          bytes: bytes.slice(start, end + 1),
          status: 206,
          contentRange: `bytes ${start + 1}-${end}/${bytes.length}`,
        }
      },
      async append() {
        throw new Error("Invalid ranges must never be written")
      },
    }),
  ).rejects.toThrow("integrity")
  await expect(
    streamPublicationDownload({
      file: { bytes: 1, sha256: "0".repeat(64) },
      signal: new AbortController().signal,
      async read() {
        return { bytes: new Uint8Array([1]), status: 206, contentRange: "bytes 0-0/1" }
      },
      async append() {},
    }),
  ).rejects.toThrow("integrity")
})

test("cancellation after a download chunk prevents further reads", async () => {
  const controller = new AbortController()
  let reads = 0
  await expect(
    streamPublicationDownload({
      file: { bytes: 4194305, sha256: "0".repeat(64) },
      signal: controller.signal,
      async read() {
        reads++
        return { bytes: new Uint8Array(4194304), status: 206, contentRange: "bytes 0-4194303/4194305" }
      },
      async append() {
        controller.abort()
      },
    }),
  ).rejects.toThrow()
  expect(reads).toBe(1)
})
