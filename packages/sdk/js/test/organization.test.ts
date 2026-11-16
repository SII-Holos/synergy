import { expect, test } from "bun:test"
import { createOrganizationClient } from "../src/organization"

test("organization clients preserve per-organization transport, credentials and HTTP errors", async () => {
  const requests: Array<{ path: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
      return Response.json(
        { ready: requests.length === 1, protocolVersion: 1 },
        { status: requests.length === 1 ? 200 : 503 },
      )
    },
  })
  let calls = 0
  const transport = Object.assign(
    (...args: Parameters<typeof fetch>) => {
      calls++
      return fetch(...args)
    },
    { preconnect: fetch.preconnect },
  )
  try {
    const first = createOrganizationClient({
      baseUrl: server.url.toString(),
      headers: { authorization: "Bearer fixture-first" },
      fetch: transport,
    })
    const second = createOrganizationClient({
      baseUrl: server.url.toString(),
      headers: { authorization: "Bearer fixture-second" },
      fetch: transport,
    })
    expect((await first.orgHealth.get({ throwOnError: true })).data).toEqual({ ready: true, protocolVersion: 1 })
    const rejected = await second.orgHealth.get()
    expect(rejected.response.status).toBe(503)
    expect(rejected.error).toEqual({ ready: false, protocolVersion: 1 })
    expect(requests).toEqual([
      { path: "/org/v1/health", authorization: "Bearer fixture-first" },
      { path: "/org/v1/health", authorization: "Bearer fixture-second" },
    ])
    expect(calls).toBe(2)
  } finally {
    await server.stop(true)
  }
})
