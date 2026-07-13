import { describe, expect, test } from "bun:test"
import { createSynergyClient } from "../src/client"

describe("plugin SDK", () => {
  test("invokes an SDK-exposed operation through the positional convenience API", async () => {
    let captured: Request | undefined
    const client = createSynergyClient({
      baseUrl: "http://synergy.test",
      fetch: async (request) => {
        captured = request
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    await client.plugin.invoke("focus", "research.graph.get", { revision: 1 }, { sessionId: "session-one" })

    expect(captured?.method).toBe("POST")
    expect(captured?.url).toBe("http://synergy.test/plugin/focus/operations/research.graph.get/invoke")
    expect(await captured?.json()).toEqual({ input: { revision: 1 }, sessionId: "session-one" })
  })
})
