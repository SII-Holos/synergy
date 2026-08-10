import { afterEach, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

afterEach(() => Server.resumeRequests())

test("rejects new HTTP work as soon as runtime shutdown starts", async () => {
  Server.beginShutdown()

  const response = await Server.App().request("/global/health")

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    name: "RuntimeShuttingDown",
    data: { message: "Synergy runtime is shutting down" },
  })
})
