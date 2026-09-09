import { afterAll, expect, test } from "bun:test"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { WebFetchTool } from "../../src/tools/webfetch"

const html =
  "<html><head><style>hidden-style</style><script>hidden-script</script></head><body><h1>Research methods</h1><p>A reproducible experiment measures the same phenomenon with independent observations.</p></body></html>"
const requests: Array<{ accept: string | null }> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push({ accept: request.headers.get("accept") })
    const pathname = new URL(request.url).pathname
    if (pathname === "/slow") {
      await Bun.sleep(100)
      return new Response("late")
    }
    if (pathname === "/missing") return new Response("missing", { status: 404 })
    if (pathname === "/forbidden") return new Response("denied", { status: 403 })
    if (pathname === "/huge") return new Response("x".repeat(5 * 1024 * 1024 + 1))
    if (pathname === "/chunked-huge")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1))
            controller.close()
          },
        }),
      )
    if (pathname === "/plain")
      return new Response("Independent observations make an experiment reproducible.", {
        headers: { "content-type": "text/plain" },
      })
    if (pathname === "/empty") return new Response("", { headers: { "content-type": "text/html" } })
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
  },
})
afterAll(() => server.stop(true))
function context(signal = new AbortController().signal) {
  const permissions: string[] = []
  const ctx: Tool.Context = {
    sessionID: crypto.randomUUID(),
    messageID: "message",
    agent: "synergy",
    abort: signal,
    metadata() {},
    async ask(input) {
      permissions.push(...input.patterns)
    },
  }
  return { ctx, permissions }
}
const tool = await WebFetchTool.init()
const url = (pathname: string) => new URL(pathname, server.url).href

test("fetches HTML through permissions and converts requested representations", async () => {
  for (const format of ["markdown", "text", "html"] as const) {
    const { ctx, permissions } = context()
    const result = await tool.execute({ url: url("/article"), format }, ctx)
    expect(permissions).toEqual([url("/article")])
    expect(result.metadata).toMatchObject({
      contentType: "text/html; charset=utf-8",
      contentLength: new TextEncoder().encode(html).length,
    })
    expect(result.output).toContain("Research methods")
    expect(requests.at(-1)?.accept).toContain(
      format === "markdown" ? "text/markdown;q=1.0" : `text/${format === "text" ? "plain" : "html"};q=1.0`,
    )
    if (format === "html") expect(result.output).toContain(html)
    else {
      expect(result.output).not.toContain("hidden-script")
      expect(result.output).not.toContain("hidden-style")
      expect(result.output).not.toContain("<h1>")
      if (format === "markdown") expect(result.output).toContain("# Research methods")
    }
  }
})
test("preserves non-HTML bodies and labels empty content quality", async () => {
  for (const format of ["markdown", "text"] as const) {
    const result = await tool.execute({ url: url("/plain"), format }, context().ctx)
    expect(result.output).toContain("Independent observations")
    expect(result.metadata.contentType).toBe("text/plain")
  }
  const empty = await tool.execute({ url: url("/empty"), format: "text" }, context().ctx)
  expect(empty.metadata.searchFailureType).toBe("low_quality_results")
  expect(empty.metadata.contentLength).toBe(0)
})
test("rejects invalid URLs before approval and avoids repeat network requests", async () => {
  const { ctx, permissions } = context()
  await expect(tool.execute({ url: "file:///private/file", format: "text" }, ctx)).rejects.toThrow(
    "http:// or https://",
  )
  expect(permissions).toEqual([])
  await tool.execute({ url: url("/plain"), format: "text" }, ctx)
  const requestCount = requests.length
  const duplicate = await tool.execute({ url: url("/plain"), format: "text" }, ctx)
  expect(duplicate.metadata.searchFailureType).toBe("duplicate_query")
  expect(requests.length).toBe(requestCount)
  expect(permissions).toHaveLength(1)
})
test("classifies upstream failures and enforces declared and streamed response limits", async () => {
  for (const [pathname, failure] of [
    ["/missing", "404 (http_404)"],
    ["/forbidden", "403 (http_403)"],
    ["/huge", "exceeds 5MB limit"],
    ["/chunked-huge", "exceeds 5MB limit"],
  ] as const) {
    await expect(tool.execute({ url: url(pathname), format: "text" }, context().ctx)).rejects.toThrow(failure)
  }
})
test("aborts slow requests at configured timeout and honors caller cancellation", async () => {
  await expect(tool.execute({ url: url("/slow"), format: "text", timeout: 0.01 }, context().ctx)).rejects.toThrow(
    "Request timed out",
  )
  const controller = new AbortController()
  controller.abort()
  await expect(tool.execute({ url: url("/slow"), format: "text" }, context(controller.signal).ctx)).rejects.toThrow(
    "Request timed out",
  )
})
