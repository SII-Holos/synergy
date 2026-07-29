import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import * as fs from "node:fs/promises"
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
  return (await fs.readdir(directory)).filter((entry) => entry.startsWith(".synergy-arxiv-"))
}

async function waitForTemporaryFile(directory: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const [temporary] = await temporaryFiles(directory)
    if (temporary) return temporary
    await Bun.sleep(2)
  }
  throw new Error("Timed out waiting for the arXiv temporary file")
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

  test.skipIf(process.platform === "win32")("preserves destination permissions during replacement", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const filepath = path.join(tmp.path, "paper.pdf")
    await Bun.write(filepath, "existing paper")
    await fs.chmod(filepath, 0o600)

    await downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    })

    expect((await fs.stat(filepath)).mode & 0o777).toBe(0o600)
  })

  test.skipIf(process.platform === "win32")("uses the process umask for a new destination", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const filepath = path.join(tmp.path, "paper.pdf")

    await downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    })

    expect((await fs.stat(filepath)).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  test("rejects replacing a symbolic-link destination", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const target = path.join(tmp.path, "target.pdf")
    const filepath = path.join(tmp.path, "paper.pdf")
    await Bun.write(target, "existing paper")
    await fs.symlink(target, filepath)

    await expect(
      downloadArxivPdf({
        url: new URL("/paper.pdf", server.url).href,
        filepath,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow("symbolic link")

    expect((await fs.lstat(filepath)).isSymbolicLink()).toBe(true)
    expect(await Bun.file(target).text()).toBe("existing paper")
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("rejects replacing a multiply-linked destination", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const filepath = path.join(tmp.path, "paper.pdf")
    const linked = path.join(tmp.path, "linked.pdf")
    await Bun.write(filepath, "existing paper")
    await fs.link(filepath, linked)

    await expect(
      downloadArxivPdf({
        url: new URL("/paper.pdf", server.url).href,
        filepath,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow("single hard link")

    expect(await Bun.file(filepath).text()).toBe("existing paper")
    expect(await Bun.file(linked).text()).toBe("existing paper")
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

  test("returns success when caller cancellation arrives after commit starts", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const filepath = path.join(tmp.path, "paper.pdf")
    const controller = new AbortController()
    const nativeRename = fs.rename
    let commitStarted!: () => void
    const started = new Promise<void>((resolve) => (commitStarted = resolve))
    using rename = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      commitStarted()
      await Bun.sleep(25)
      await nativeRename(source, target)
    })

    const download = downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: controller.signal,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    })
    await started
    controller.abort(new DOMException("Session cancelled", "AbortError"))

    await expect(download).resolves.toBe(PDF.byteLength)
    expect(new Uint8Array(await Bun.file(filepath).arrayBuffer())).toEqual(PDF)
  })

  test("reports caller cancellation when commit fails after cancellation", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const filepath = path.join(tmp.path, "paper.pdf")
    const controller = new AbortController()
    let commitStarted!: () => void
    let finishCommit!: () => void
    const started = new Promise<void>((resolve) => (commitStarted = resolve))
    const finish = new Promise<void>((resolve) => (finishCommit = resolve))
    using rename = spyOn(fs, "rename").mockImplementation(async () => {
      commitStarted()
      await finish
      throw new Error("Atomic commit failed")
    })

    const download = downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: controller.signal,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    })
    await started
    controller.abort(new DOMException("Session cancelled", "AbortError"))
    finishCommit()

    await expect(download).rejects.toMatchObject({ name: "AbortError" })
    expect(await Bun.file(filepath).exists()).toBe(false)
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })

  test("reports timeout when commit fails after the deadline", async () => {
    await using tmp = await tmpdir()
    using server = serve(() => PDF)
    const filepath = path.join(tmp.path, "paper.pdf")
    using rename = spyOn(fs, "rename").mockImplementation(async () => {
      await Bun.sleep(25)
      throw new Error("Atomic commit failed")
    })

    await expect(
      downloadArxivPdf({
        url: new URL("/paper.pdf", server.url).href,
        filepath,
        signal: new AbortController().signal,
        timeoutMs: 10,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow("Download timed out")

    expect(await Bun.file(filepath).exists()).toBe(false)
    expect(await temporaryFiles(tmp.path)).toEqual([])
  })

  test.skipIf(process.platform === "win32")("reports temporary-file cleanup failures", async () => {
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
    const download = downloadArxivPdf({
      url: new URL("/paper.pdf", server.url).href,
      filepath,
      signal: new AbortController().signal,
      timeoutMs: 100,
      maxBytes: 1_024,
    })

    await waitForTemporaryFile(tmp.path)
    await fs.chmod(tmp.path, 0o500)
    try {
      await expect(download).rejects.toBeInstanceOf(AggregateError)
    } finally {
      await fs.chmod(tmp.path, 0o700)
    }
  })
})
