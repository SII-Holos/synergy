import { describe, expect, test } from "bun:test"
import path from "path"
import { readdir } from "node:fs/promises"
import { downloadArxivPdf } from "../../src/tool/arxiv"
import { tmpdir } from "../fixture/fixture"

const PDF = new TextEncoder().encode("%PDF-1.7\nstreamed paper\n%%EOF")

function serve(body: () => BodyInit, headers?: HeadersInit) {
  return Bun.serve({
    port: 0,
    fetch() {
      return new Response(body(), {
        headers: {
          "content-type": "application/pdf",
          ...headers,
        },
      })
    },
  })
}

async function temporaryFiles(directory: string) {
  return (await readdir(directory)).filter((entry) => entry.startsWith(".synergy-arxiv-"))
}

describe("arXiv PDF download", () => {
  test("streams the complete response to the destination", async () => {
    await using tmp = await tmpdir()
    using server = serve(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PDF.slice(0, 8))
            controller.enqueue(PDF.slice(8))
            controller.close()
          },
        }),
      { "content-length": String(PDF.byteLength) },
    )
    const filepath = path.join(tmp.path, "paper.pdf")
    await Bun.write(filepath, "existing paper")

    const size = await downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    })

    expect(size).toBe(PDF.byteLength)
    expect(new Uint8Array(await Bun.file(filepath).arrayBuffer())).toEqual(PDF)
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })

  test("times out while the response body is stalled and preserves the destination", async () => {
    await using tmp = await tmpdir()
    using server = serve(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PDF.slice(0, 8))
          },
        }),
    )
    const filepath = path.join(tmp.path, "paper.pdf")
    await Bun.write(filepath, "existing paper")

    await expect(
      downloadArxivPdf({
        url: new URL("/paper.pdf", server.url).href,
        filepath,
        signal: new AbortController().signal,
        timeoutMs: 25,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow("Download timed out")

    expect(await Bun.file(filepath).text()).toBe("existing paper")
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })

  test("rejects a chunked response that exceeds the byte limit", async () => {
    await using tmp = await tmpdir()
    using server = serve(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PDF.slice(0, 12))
            controller.enqueue(PDF.slice(12))
            controller.close()
          },
        }),
    )
    const filepath = path.join(tmp.path, "paper.pdf")

    await expect(
      downloadArxivPdf({
        url: new URL("/paper.pdf", server.url).href,
        filepath,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maxBytes: 16,
      }),
    ).rejects.toThrow("exceeds the 16-byte limit")

    expect(await Bun.file(filepath).exists()).toBe(false)
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })

  test("honors caller cancellation while reading the response body", async () => {
    await using tmp = await tmpdir()
    using server = serve(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PDF.slice(0, 8))
          },
        }),
    )
    const filepath = path.join(tmp.path, "paper.pdf")
    const controller = new AbortController()
    const download = downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: controller.signal,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    })

    setTimeout(() => controller.abort(new DOMException("Session cancelled", "AbortError")), 25)

    await expect(download).rejects.toMatchObject({ name: "AbortError" })
    expect(await Bun.file(filepath).exists()).toBe(false)
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })
})
