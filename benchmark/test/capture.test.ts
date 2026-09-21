import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installCapture } from "../runtime/capture.mjs"
import { startSessionCapture } from "../runtime/session-relay.mjs"

test("native recorder includes auxiliary calls without changing the request or streaming bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-capture-"))
  const body = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.text())
      expect(request.headers.get("x-benchmark-client-request")).toMatch(/^[a-f0-9-]{36}$/)
      expect(request.headers.get("content-length")).toBe(String(Buffer.byteLength(requests.at(-1)!)))
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const restore = installCapture({ root, endpoint: server.url.toString().replace(/\/$/, "") })
  try {
    installCapture({ root, endpoint: server.url.toString().replace(/\/$/, "") })
    for (const tools of [[], [{ type: "function", function: { name: "read" } }]]) {
      const payload = JSON.stringify({ model: "fixture", tools, messages: [] })
      const response = await fetch(new URL("chat/completions", server.url), { method: "POST", body: payload })
      expect(await response.text()).toBe(body)
    }
    expect(requests).toHaveLength(2)
    const entries = await readdir(root)
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      const value = JSON.parse(await readFile(path.join(root, entry, "request.json"), "utf8"))
      expect(value.status).toBe("completed")
      expect(value.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3 })
    }
  } finally {
    restore()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("native observation preserves a non-JSON provider error and HTTP retry semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-capture-error-"))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("upstream overloaded", { status: 503 }),
  })
  const restore = installCapture({ root, endpoint: server.url.toString().replace(/\/$/, "") })
  try {
    const response = await fetch(new URL("chat/completions", server.url), { method: "POST", body: "{}" })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("upstream overloaded")
    const [id] = await readdir(root)
    const record = JSON.parse(await readFile(path.join(root, id, "request.json"), "utf8"))
    expect(record.status).toBe("http_error")
    expect(record.usage).toBeNull()
  } finally {
    restore()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("native observation does not rewrite malformed SSE bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-capture-frame-"))
  const body = "data: not-json\n\ndata: [DONE]\n\n"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  })
  const restore = installCapture({ root, endpoint: server.url.toString().replace(/\/$/, "") })
  try {
    const response = await fetch(new URL("chat/completions", server.url), { method: "POST", body: "{}" })
    expect(await response.text()).toBe(body)
    const [id] = await readdir(root)
    const record = JSON.parse(await readFile(path.join(root, id, "request.json"), "utf8"))
    expect(record.usage).toBeNull()
    expect(record.parse_errors).toBeGreaterThan(0)
  } finally {
    restore()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("streamed UTF-8 requests and multi-megabyte responses retain exact bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-capture-long-"))
  const payload = JSON.stringify({ model: "fixture", text: "中文🙂" })
  const responseBody =
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: "x".repeat(5 * 1024 * 1024) }, finish_reason: "stop" }] }) +
    '\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(await request.text()).toBe(payload)
      expect(request.headers.get("content-length")).toBe(String(Buffer.byteLength(payload)))
      return new Response(responseBody, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const restore = installCapture({ root, endpoint: server.url.toString().replace(/\/$/, "") })
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const response = await fetch(new Request(new URL("chat/completions", server.url), { method: "POST", body: stream }))
    expect(await response.text()).toBe(responseBody)
    expect(response.url).toBe(new URL("chat/completions", server.url).href)
    const [id] = await readdir(root)
    expect(await readFile(path.join(root, id, "response.bin"), "utf8")).toBe(responseBody)
    const record = JSON.parse(await readFile(path.join(root, id, "request.json"), "utf8"))
    expect(record.status).toBe("completed")
    expect(record.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3 })
  } finally {
    restore()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("native cancellation completes even if upstream reader cancellation never acknowledges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-capture-cancel-"))
  const original = globalThis.fetch
  let cancelled = false
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { preconnect: original.preconnect },
  )
  const restore = installCapture({ root, endpoint: "http://fixture.invalid/v1" })
  try {
    const response = await fetch("http://fixture.invalid/v1/chat/completions", { method: "POST", body: "{}" })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(cancelled).toBe(true)
    const [id] = await readdir(root)
    const record = JSON.parse(await readFile(path.join(root, id, "request.json"), "utf8"))
    expect(record.status).toBe("interrupted")
    expect(record.usage).toBeNull()
  } finally {
    restore()
    globalThis.fetch = original
    await rm(root, { recursive: true, force: true })
  }
})

test("session-export release capture follows inherited Bun worker launches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-session-workers-"))
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      expect(request.headers.get("x-benchmark-client-request")).toMatch(/^[a-f0-9-]{36}$/)
      return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 3 } })
    },
  })
  const capture = startSessionCapture({
    root: path.join(root, "wire"),
    endpoint: server.url.toString().replace(/\/$/, ""),
  })
  try {
    const worker = path.join(root, "worker.mjs")
    const parent = path.join(root, "parent.mjs")
    const invoke = `await (await fetch(process.env.BENCH_GATEWAY_BASE + '/chat/completions', {method:'POST',body:JSON.stringify({role:process.argv[2],text:'中文😀'})})).text()`
    await Bun.write(worker, invoke)
    await Bun.write(
      parent,
      `${invoke}; const child=Bun.spawn([process.execPath,'run',${JSON.stringify(worker)},'child'],{stdout:'pipe',stderr:'pipe'}); process.exitCode=await child.exited`,
    )
    const child = Bun.spawn([process.execPath, "run", parent, "primary"], {
      env: {
        PATH: process.env.PATH,
        BENCH_GATEWAY_BASE: server.url.toString().replace(/\/$/, ""),
        BENCH_CAPTURE_DIR: path.join(root, "wire"),
        BENCH_CAPTURE_ENDPOINT: capture.url,
        HTTP_PROXY: "http://127.0.0.1:1",
        BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, "../runtime/session-capture.mjs")}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(requests).toEqual([
      { role: "primary", text: "中文😀" },
      { role: "child", text: "中文😀" },
    ])
    const entries = await readdir(path.join(root, "wire"))
    expect(entries).toHaveLength(2)
    for (const id of entries) {
      const record = await Bun.file(path.join(root, "wire", id, "request.json")).json()
      expect(record.status).toBe("completed")
      expect(record.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3 })
    }
  } finally {
    await capture.close(1)
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("session transport recording survives native CLI exit without keeping the CLI alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-session-exit-"))
  const arrived = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      arrived.resolve()
      await release.promise
      return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 3 } })
    },
  })
  const capture = startSessionCapture({
    root: path.join(root, "wire"),
    endpoint: server.url.toString().replace(/\/$/, ""),
  })
  const entry = path.join(root, "entry.mjs")
  await Bun.write(
    entry,
    "await (await fetch(process.env.BENCH_GATEWAY_BASE+'/chat/completions',{method:'POST',body:'{}'})).text()",
  )
  const child = Bun.spawn([process.execPath, "run", entry], {
    env: {
      PATH: process.env.PATH,
      BENCH_GATEWAY_BASE: server.url.toString().replace(/\/$/, ""),
      BENCH_CAPTURE_ENDPOINT: capture.url,
      BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, "../runtime/session-capture.mjs")}`,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    await arrived.promise
    child.kill("SIGTERM")
    await child.exited
    release.resolve()
    await capture.close(1)
    const [id] = await readdir(path.join(root, "wire"))
    const record = await Bun.file(path.join(root, "wire", id, "request.json")).json()
    expect(record.status).toBe("completed")
    expect(record.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3 })
  } finally {
    release.resolve()
    child.kill()
    await capture.close(1)
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test.each([false, true])("session observer cancellation during drain=%s preserves unknown usage", async (draining) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-session-abort-"))
  const arrived = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      arrived.resolve()
      await release.promise
      return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 3 } })
    },
  })
  const capture = startSessionCapture({ root, endpoint: server.url.toString().replace(/\/$/, "") })
  try {
    const delivery = fetch(capture.url + "/chat/completions", { method: "POST", body: "{}" }).catch(() => null)
    await arrived.promise
    const drain = draining ? capture.close(1) : undefined
    const result = await capture.close(1, true)
    expect(result.timed_out).toBe(false)
    await drain
    await delivery
    const [id] = await readdir(root)
    const record = await Bun.file(path.join(root, id, "request.json")).json()
    expect(record.status).toBe("interrupted")
    expect(record.usage).toBeNull()
  } finally {
    release.resolve()
    await capture.close(1, true)
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
