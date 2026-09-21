import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import type { Provider as SDK } from "ai"
import { Provider } from "../../src/provider/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Auth } from "../../src/provider/api-key"
import { ProviderAuthRecovery } from "../../src/provider/auth-recovery"
import { ProviderProfile } from "../../src/provider/profile"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

afterEach(() => ProviderSdkSource.register(undefined))

async function providerFetch(options: Record<string, unknown>, providerID = `fetch-fixture-${crypto.randomUUID()}`) {
  let transport: ProviderProfile.FetchLike | undefined
  const factory: ProviderSdkSource.Factory = (options) => {
    transport = options.fetch as ProviderProfile.FetchLike
    return { languageModel: () => ({ modelId: "fixture" }) } as unknown as SDK
  }
  ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory })
  const model = {
    id: "fixture",
    providerID,
    api: { npm: "fixture", id: "fixture", url: "http://provider.invalid/v1" },
    options: {},
    headers: {},
  } as Provider.Model
  const previous = process.env.SYNERGY_AGENT_WORKER
  process.env.SYNERGY_AGENT_WORKER = "1"
  try {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Provider.configureWorkerProvider(model, {
          options: { ...options, timeout: false },
          timeouts: { ttfbMs: 60000, idleMs: false, wallMs: false },
        })
        await Provider.getLanguage(model)
      },
    })
    if (!transport) throw new Error("SDK did not receive its transport")
    return transport
  } finally {
    if (previous === undefined) delete process.env.SYNERGY_AGENT_WORKER
    else process.env.SYNERGY_AGENT_WORKER = previous
  }
}

test.each([undefined, "http://proxy.invalid:8080"])(
  "provider preserves native fetch options through %s",
  async (proxy) => {
    let received: RequestInit | undefined
    const transport = await providerFetch({
      proxy,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        received = init
        return new Response(null, { status: 204 })
      },
    })
    const response = await RolloutTransport.provide(
      async () => {},
      () => transport("http://provider.invalid/v1"),
    )
    expect(response.status).toBe(204)
    expect(received).toMatchObject({ timeout: false, ...(proxy ? { proxy } : {}) })
  },
)

test.each(["auth", "worker", "proxy"] as const)(
  "recorded %s transport preserves upload bytes and length across authentication retry",
  async (mode) => {
    const providerID = `length-fixture-${crypto.randomUUID()}`
    await Auth.set(providerID, { type: "api", key: "fixture-key" })
    const expected = "中文🙂".repeat(40000)
    const bytes = new TextEncoder().encode(expected)
    const source = new Uint8Array(bytes.byteLength + 6)
    source.set(bytes, 3)
    const body =
      mode === "auth" ? expected : mode === "worker" ? bytes : new DataView(source.buffer, 3, bytes.byteLength)
    const requests: Array<{ length?: string; encoding?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({
        length: request.headers["content-length"],
        encoding: request.headers["transfer-encoding"],
        body: Buffer.concat(chunks).toString(),
      })
      response
        .writeHead(requests.length === 1 ? 401 : 200, { "Content-Type": "text/plain" })
        .end(requests.length === 1 ? "unauthorized" : "ok")
    }).listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing fixture address")
    const events: RolloutTransport.Event[] = []
    try {
      const url = `http://127.0.0.1:${address.port}`
      const transport =
        mode === "auth"
          ? ProviderAuthRecovery.wrapFetch(providerID)
          : await providerFetch({ ...(mode === "proxy" ? { proxy: url } : {}) }, providerID)
      const response = await RolloutTransport.provide(
        async (event) => {
          events.push(event)
        },
        () =>
          transport(mode === "proxy" ? "http://provider.invalid/v1" : `${url}/v1`, {
            method: "POST",
            headers: { Authorization: "Bearer fixture-key" },
            body,
          }),
      )
      expect(await response.text()).toBe("ok")
      expect(requests.map(({ length, encoding }) => ({ length, encoding }))).toEqual(
        Array.from({ length: 2 }, () => ({ length: String(bytes.byteLength), encoding: undefined })),
      )
      expect(requests.map(({ body }) => body)).toEqual([expected, expected])
      expect(
        events
          .filter((event) => event.type === "chunk" && event.channel === "request")
          .reduce((size, event) => size + (event.type === "chunk" ? event.data.byteLength : 0), 0),
      ).toBe(bytes.byteLength * 2)
      expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "completed" })
    } finally {
      await Auth.remove(providerID)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  },
)

test("recording keeps an unknown-length upload streaming across authentication retry", async () => {
  const providerID = `stream-fixture-${crypto.randomUUID()}`
  await Auth.set(providerID, { type: "api", key: "fixture-key" })
  let producer!: ReadableStreamDefaultController<Uint8Array>
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      producer = controller
    },
  })
  const bodies: string[] = []
  const events: RolloutTransport.Event[] = []
  const transport = ProviderAuthRecovery.wrapFetch(providerID, async (input) => {
    const request = input as Request
    entered()
    const reader = request.body!.getReader()
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    bodies.push(Buffer.concat(chunks).toString())
    return new Response(null, { status: bodies.length === 1 ? 401 : 204 })
  })
  const response = RolloutTransport.provide(
    async (event) => {
      events.push(event)
    },
    () => transport("http://fixture.invalid/v1", { method: "POST", body: stream }),
  )
  try {
    await started
    producer.enqueue(new TextEncoder().encode("streamed bytes"))
    producer.close()
    expect((await response).status).toBe(204)
    expect(bodies).toEqual(["streamed bytes", "streamed bytes"])
    expect(events.filter((event) => event.type === "attempt-end").map((event) => event.status)).toEqual([
      "failed",
      "completed",
    ])
  } finally {
    await Auth.remove(providerID)
  }
})

test.each(["proxy", "direct"] as const)("%s transport applies Request init overrides", async (mode) => {
  const requests: Array<{ method: string; header: string | null; body: string }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ method: request.method, header: request.headers.get("x-fixture"), body: await request.text() })
      return new Response("ok")
    },
  })
  try {
    const transport = await providerFetch(mode === "proxy" ? { proxy: server.url.href } : { noProxy: true })
    const request = new Request(server.url, { method: "POST", headers: { "x-fixture": "before" }, body: "before" })
    const response = await transport(request, { method: "PUT", headers: { "x-fixture": "after" }, body: "after" })
    expect(await response.text()).toBe("ok")
    expect(requests).toEqual([{ method: "PUT", header: "after", body: "after" }])
  } finally {
    await server.stop(true)
  }
})

test.each(["headers", "signal"] as const)(
  "provider preserves a Request caller's %s alongside its timeout",
  async (field) => {
    const controller = new AbortController()
    let received: Request | undefined
    const transport = await providerFetch({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        received = new Request(input, init)
        return new Response(null, { status: 204 })
      },
    })
    await transport(
      new Request("http://fixture.invalid/v1", {
        headers: { "x-fixture": "original" },
        signal: controller.signal,
      }),
    )
    const reason = new Error("caller cancelled")
    controller.abort(reason)
    if (field === "headers") expect(received?.headers.get("x-fixture")).toBe("original")
    else expect(received?.signal.reason).toBe(reason)
  },
)
