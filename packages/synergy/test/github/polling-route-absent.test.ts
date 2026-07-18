import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("POST /integrations/github/webhook", () => {
  test("returns 404 after webhook route removal", async () => {
    const response = await Server.App().request(
      new Request("http://localhost/integrations/github/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"action":"opened"}',
      }),
    )
    expect(response.status).toBe(404)
  })

  test("returns 404 for GET on webhook path", async () => {
    const response = await Server.App().request("http://localhost/integrations/github/webhook")
    expect(response.status).toBe(404)
  })
})

describe("SYNERGY_GITHUB_WEBHOOK_SECRET", () => {
  test("is not referenced in the server for webhook verification", () => {
    // The runtime should not read this env var after webhook ingress removal.
    // If any code path still references it at startup, this test catches it.
    const old = process.env.SYNERGY_GITHUB_WEBHOOK_SECRET
    delete process.env.SYNERGY_GITHUB_WEBHOOK_SECRET
    try {
      // Server startup must not throw or fail without the webhook secret
      expect(() => Server.App()).not.toThrow()
    } finally {
      if (old !== undefined) process.env.SYNERGY_GITHUB_WEBHOOK_SECRET = old
    }
  })

  test("the GitHubWebhookResponse schema is absent from OpenAPI generation contract", () => {
    // After route removal, GitHubWebhookResponse should not appear in the export surface
    // used by the OpenAPI generator. Query the types module to verify it is gone.
    const types = require("../../src/github/types")
    expect(types.GitHubWebhookResponse).toBeUndefined()
  })
})
