import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { spaceFetch } from "../../src/context/space-fetch"

test("a space-owned generated client preserves request authority and cancels requests that supplied their own signal", async () => {
  const view = new AbortController()
  const caller = new AbortController()
  const response = Promise.withResolvers<Response>()
  const requests: Request[] = []
  const transport = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(input as Request)
      return response.promise
    },
    { preconnect() {} },
  )
  const client = createSynergyClient({
    baseUrl: "https://runtime.example",
    scopeID: "scope-a",
    headers: { authorization: "Bearer synthetic-credential" },
    fetch: spaceFetch(view.signal, transport),
    throwOnError: true,
  })
  const request = client.global.capabilities({ signal: caller.signal })
  await Promise.resolve()
  await Promise.resolve()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer synthetic-credential")
  expect(requests[0]!.headers.get("x-synergy-scope-id")).toBe("scope-a")
  view.abort()
  expect(requests[0]!.signal.aborted).toBe(true)
  let cancelled = false
  response.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
    ),
  )
  await expect(request).rejects.toMatchObject({ name: "AbortError" })
  expect(cancelled).toBe(true)
  await expect(client.global.capabilities()).rejects.toMatchObject({ name: "AbortError" })
  expect(requests).toHaveLength(1)
})

test("caller cancellation keeps the view usable and never retries a failed write", async () => {
  const view = new AbortController()
  const caller = new AbortController()
  const requests: Request[] = []
  const fetcher = spaceFetch(
    view.signal,
    Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input as Request
        requests.push(request)
        if (request.method === "POST") throw new TypeError("network unavailable")
        return Response.json({ ok: true })
      },
      { preconnect() {} },
    ),
  )
  caller.abort()
  await expect(fetcher("https://runtime.example", { signal: caller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(view.signal.aborted).toBe(false)
  expect(requests).toHaveLength(0)
  expect((await fetcher("https://runtime.example")).status).toBe(200)
  await expect(fetcher("https://runtime.example", { method: "POST", body: "{}" })).rejects.toThrow(
    "network unavailable",
  )
  expect(requests).toHaveLength(2)
})
