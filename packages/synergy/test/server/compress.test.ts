import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

const gzipHeaders = { "Accept-Encoding": "gzip" }

describe("server response compression", () => {
  test("compresses large JSON responses when the client accepts gzip", async () => {
    const res = await Server.App().request("/doc", { headers: gzipHeaders })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBe("gzip")

    const compressed = await res.arrayBuffer()
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(compressed)))
    expect(compressed.byteLength).toBeLessThan(text.length)
    expect(JSON.parse(text).openapi).toBe("3.1.1")
  })

  test("serves identity responses when the client does not accept gzip", async () => {
    const res = await Server.App().request("/doc")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBeNull()
    expect((await res.json()).openapi).toBe("3.1.1")
  })

  test("never compresses the SSE event stream", async () => {
    const res = await Server.App().request("/event", { headers: gzipHeaders })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("content-encoding")).toBeNull()

    const reader = res.body!.getReader()
    try {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for the first SSE event")), 5000),
        ),
      ])
      expect(new TextDecoder().decode(chunk.value)).toContain("server.connected")
    } finally {
      await reader.cancel().catch(() => {})
    }
  })
})
