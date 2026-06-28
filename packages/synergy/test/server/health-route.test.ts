import { describe, expect, test } from "bun:test"
import { startupScopeLabel } from "../../src/server/runtime"
import { Server } from "../../src/server/server"

describe("GET /global/health", () => {
  test("returns 200 with healthy: true and required fields", async () => {
    const app = Server.App()
    const res = await app.request("/global/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.healthy).toBe(true)
    expect(body.version).toBeTypeOf("string")
    expect(body.modelReady).toBeTypeOf("boolean")
  })

  test("includes channel field with a valid string value", async () => {
    const app = Server.App()
    const res = await app.request("/global/health")
    const body = await res.json()
    expect(body).toHaveProperty("channel")
    expect(typeof body.channel).toBe("string")
    expect(body.channel.length).toBeGreaterThan(0)
  })
})
