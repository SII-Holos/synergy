import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { recordedProvider, readRequests } from "../../script/acceptance/provider"
import { acceptanceRuntime } from "../../script/acceptance/runtime"
import { fixtureSettings } from "./support"

test("isolated Runtime variants retain requests in one scenario ledger", async () => {
  await using tmp = await tmpdir()
  using upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ usage: { prompt_tokens: 7, completion_tokens: 2 } }),
  })
  const settings = await fixtureSettings(tmp.path, upstream.url.toString())
  for (const variant of ["first", "second"]) {
    await using host = await acceptanceRuntime(path.join(tmp.path, variant), settings, { recordingDirectory: tmp.path })
    const response = await fetch(`${host.recorder.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.recorder.token}` },
      body: JSON.stringify({ model: "model" }),
    })
    expect(response.status).toBe(200)
    await response.text()
  }
  const ledger = await readRequests(tmp.path)
  expect(ledger).toHaveLength(2)
  expect(ledger.every((entry) => entry.status === "completed" && entry.usage?.input === 7)).toBe(true)
})

test("provider capture preserves actual bytes and records every auxiliary request without credentials", async () => {
  await using tmp = await tmpdir()
  const requests: string[] = []
  const wire =
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"usage":{"prompt_tokens":17,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
  using upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer upstream-secret")
      requests.push(await request.text())
      return new Response(wire, { headers: { "content-type": "text/event-stream" } })
    },
  })
  await using gateway = await recordedProvider({
    directory: tmp.path,
    upstream: `${upstream.url}v1`,
    apiKey: "upstream-secret",
    provider: "fixture",
  })
  for (const purpose of ["root", "child", "auxiliary"]) {
    const body = JSON.stringify({ model: "model", stream: true, messages: [{ role: "user", content: purpose }] })
    const response = await fetch(`${gateway.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.token}` },
      body,
    })
    expect(await response.text()).toBe(wire)
    expect(requests.at(-1)).toBe(body)
  }
  const ledger = await readRequests(tmp.path)
  expect(ledger).toHaveLength(3)
  expect(
    ledger.every((entry) => entry.status === "completed" && entry.usage?.input === 17 && entry.usage.output === 3),
  ).toBe(true)
  for (const file of new Bun.Glob("requests/**/*").scanSync({ cwd: tmp.path, onlyFiles: true }))
    expect(await Bun.file(path.join(tmp.path, file)).text()).not.toContain("upstream-secret")
  const denied = await fetch(`${gateway.url}/chat/completions`, { method: "POST", body: "{}" })
  expect(denied.status).toBe(401)
  expect(requests).toHaveLength(3)
})

test("a fault before response bytes remains a recorded request with unknown usage", async () => {
  await using tmp = await tmpdir()
  using upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unused") })
  const barriers: string[] = []
  await using gateway = await recordedProvider({
    directory: tmp.path,
    upstream: upstream.url.toString(),
    apiKey: "secret",
    provider: "fixture",
    fault: {
      stage: "before-bytes",
      onTriggered: (stage) => {
        barriers.push(stage)
      },
    },
  })
  const response = await fetch(`${gateway.url}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ model: "model" }),
  })
  expect(response.status).toBe(502)
  expect(barriers).toEqual(["before-bytes"])
  expect(await readRequests(tmp.path)).toEqual([expect.objectContaining({ status: "failed", usage: null })])
})

test("a started but unfinished request is retained as unknown after recorder loss", async () => {
  await using tmp = await tmpdir()
  await Bun.write(
    path.join(tmp.path, "requests/unfinished/request.json"),
    JSON.stringify({ id: "unfinished", status: "unknown", usage: null }),
  )
  await Bun.write(path.join(tmp.path, "requests/corrupt/request.json"), "{")
  expect(await readRequests(tmp.path)).toEqual([
    { id: "corrupt", status: "unknown", usage: null },
    { id: "unfinished", status: "unknown", usage: null },
  ])
})

test("an armed argument fault ignores auxiliary requests and empty deltas, then preserves an incomplete delivered frame", async () => {
  await using tmp = await tmpdir()
  using upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"echo done\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const triggered: string[] = []
  await using gateway = await recordedProvider({
    directory: tmp.path,
    upstream: upstream.url.toString(),
    apiKey: "fixture",
    provider: "fixture",
  })
  gateway.arm({
    stage: "during-tool-arguments",
    matches: (body) => body.model === "main",
    onTriggered: (stage) => {
      triggered.push(stage)
    },
  })
  const send = (model: string) =>
    fetch(`${gateway.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.token}` },
      body: JSON.stringify({ model, stream: true }),
    })
  expect(await (await send("auxiliary")).text()).toContain("[DONE]")
  expect(triggered).toEqual([])
  const response = await send("main")
  const reader = response.body!.getReader()
  let prefix = ""
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      prefix += new TextDecoder().decode(next.value)
    }
  } catch {}
  expect(triggered).toEqual(["during-tool-arguments"])
  expect(prefix).toContain('"arguments":"')
  expect(prefix).not.toContain("[DONE]")
  expect(prefix.trim().endsWith("}")).toBe(false)
  const ledger = await readRequests(tmp.path)
  const failed = ledger.find((entry) => entry.model === "main")!
  expect(failed.status).toBe("failed")
  expect(await Bun.file(path.join(tmp.path, "requests", failed.id, "delivered.bin")).text()).toBe(prefix)
})

test("client cancellation is recorded as cancelled and recorder disposal drains accounting", async () => {
  await using tmp = await tmpdir()
  using upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const gateway = await recordedProvider({
    directory: tmp.path,
    upstream: upstream.url.toString(),
    apiKey: "fixture",
    provider: "fixture",
  })
  const abort = new AbortController()
  const response = await fetch(`${gateway.url}/chat/completions`, {
    method: "POST",
    signal: abort.signal,
    headers: { authorization: `Bearer ${gateway.token}` },
    body: '{"model":"main"}',
  })
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  abort.abort()
  await reader.cancel().catch(() => {})
  await gateway[Symbol.asyncDispose]()
  expect(await readRequests(tmp.path)).toEqual([expect.objectContaining({ status: "cancelled", usage: null })])
})
