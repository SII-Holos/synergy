import { expect, test } from "bun:test"
import { createImageActions } from "../../src/utils/image-actions"

const image = { id: "image", src: "https://images.example/photo.jpg", filename: "photo.jpg", mime: "image/jpeg" }
const signal = () => new AbortController().signal
const translate = (message: { message?: string }) => message.message ?? ""

test("native save preserves original bytes and distinguishes cancellation", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 42])
  let received: { operation: string; data: string; filename: string; mime: string } | undefined
  const actions = createImageActions({
    serverUrl: () => "https://server.example",
    translate,
    fetcher: (async (_request: Request) =>
      new Response(bytes, { headers: { "Content-Type": "image/jpeg" } })) as typeof fetch,
    fileAction: async (request) => {
      received = request
      return { cancelled: true }
    },
  })
  expect(await actions.save!(image, signal())).toBe("cancelled")
  expect(received).toEqual({
    operation: "save",
    data: Buffer.from(bytes).toString("base64"),
    filename: "photo.jpg",
    mime: "image/jpeg",
  })
})

test("aborted reads never dispatch a native action", async () => {
  const abort = new AbortController()
  let called = false
  const actions = createImageActions({
    serverUrl: () => "https://server.example",
    translate,
    fetcher: (async (_request: Request) => {
      abort.abort()
      return new Response("old")
    }) as typeof fetch,
    fileAction: async () => {
      called = true
      return { cancelled: false }
    },
  })
  await expect(actions.save!(image, abort.signal)).rejects.toThrow()
  expect(called).toBe(false)
})

test("unreadable images fail instead of reporting a dispatched download", async () => {
  const actions = createImageActions({
    serverUrl: () => "https://server.example",
    translate,
    fetcher: (async (_request: Request) => new Response("denied", { status: 403 })) as typeof fetch,
  })
  await expect(actions.save!(image, signal())).rejects.toThrow("403")
})

test("asset reads use the server SDK and preserve the download URL", async () => {
  const requests: string[] = []
  const actions = createImageActions({
    serverUrl: () => "https://server.example/api",
    translate,
    fetcher: (async (request: Request) => {
      requests.push(request.url)
      return new Response("original", { headers: { "Content-Type": "image/png" } })
    }) as typeof fetch,
    fileAction: async () => ({ cancelled: false }),
  })
  expect(
    await actions.save!({ ...image, downloadUrl: "https://server.example/api/asset/0123456789abcdef.png" }, signal()),
  ).toBe("completed")
  expect(requests).toEqual(["https://server.example/api/asset/0123456789abcdef.png"])
})
