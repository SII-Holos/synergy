import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createPluginSurfaceOperations } from "../../src/plugin/surface-operations"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

test("uses the generated client with its origin, authentication and bound Scope", async () => {
  const requests: Request[] = []
  const client = createSynergyClient({
    baseUrl: "https://synergy.test/proxy/host",
    headers: { Authorization: "Bearer fixture-token" },
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        requests.push(request instanceof Request ? request : new Request(request))
        return Response.json({ data: { result: "ok" } })
      },
      { preconnect() {} },
    ),
  })
  const lifetime = createPluginSurfaceLifetime(() => {})
  const operations = createPluginSurfaceOperations({
    client,
    pluginId: "demo",
    scopeId: "scope-a",
    sessionId: "session-a",
    lifetime: lifetime.context,
    contributions: [{ kind: "operation", id: "read", type: "query", expose: ["ui"], input: {}, output: {} }],
  })
  await expect(operations.query("read", { value: 1 })).resolves.toEqual({ result: "ok" })
  const request = requests[0]!
  expect(request.url).toBe("https://synergy.test/proxy/host/plugin/demo/operations/read/invoke?scopeID=scope-a")
  expect(request.headers.get("authorization")).toBe("Bearer fixture-token")
  expect(request.headers.get("x-synergy-plugin-caller")).toBe("ui")
  expect(await request.json()).toEqual({ input: { value: 1 }, sessionId: "session-a" })
  lifetime.dispose()
  await expect(operations.query("read")).rejects.toThrow()
  expect(requests).toHaveLength(1)
})

test("preserves operation error codes and validation issues", async () => {
  const client = createSynergyClient({
    baseUrl: "https://synergy.test",
    fetch: Object.assign(
      async () =>
        Response.json(
          {
            code: "INVALID_INPUT",
            message: "Input is invalid",
            issues: [{ path: "/value" }],
          },
          { status: 400 },
        ),
      { preconnect() {} },
    ),
  })
  const lifetime = createPluginSurfaceLifetime(() => {})
  const operations = createPluginSurfaceOperations({
    client,
    pluginId: "demo",
    scopeId: "scope-a",
    lifetime: lifetime.context,
    contributions: [{ kind: "operation", id: "read", type: "query", expose: ["ui"], input: {}, output: {} }],
  })
  await expect(operations.query("read")).rejects.toMatchObject({
    message: "Input is invalid",
    code: "INVALID_INPUT",
    issues: [{ path: "/value" }],
  })
  lifetime.dispose()
})
