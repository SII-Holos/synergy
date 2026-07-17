import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "crypto"
import { GitHubStore } from "../../src/github/store"
import { Server } from "../../src/server/server"

const secret = "test-webhook-secret"
const deliveries = new Set<string>()
let previousSecret: string | undefined

function signedRequest(body: string, deliveryGuid: string, event = "issues") {
  deliveries.add(deliveryGuid)
  return new Request("http://localhost/integrations/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryGuid,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  })
}

beforeEach(() => {
  previousSecret = process.env.SYNERGY_GITHUB_WEBHOOK_SECRET
  process.env.SYNERGY_GITHUB_WEBHOOK_SECRET = secret
})

afterEach(async () => {
  if (previousSecret === undefined) delete process.env.SYNERGY_GITHUB_WEBHOOK_SECRET
  else process.env.SYNERGY_GITHUB_WEBHOOK_SECRET = previousSecret
  await Promise.all([...deliveries].map((guid) => GitHubStore.remove(guid)))
  deliveries.clear()
})

describe("POST /integrations/github/webhook", () => {
  test("verifies and durably accepts a delivery before acknowledging it", async () => {
    const guid = `route-valid-${crypto.randomUUID()}`
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 7 },
      repository: { full_name: "owner/repo" },
      sender: { login: "alice" },
      issue: { title: "Crash", body: "The application crashes." },
    })

    const response = await Server.App().request(signedRequest(body, guid))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: true, duplicate: false })
    expect(await GitHubStore.get(guid)).toMatchObject({
      deliveryGuid: guid,
      installationId: 7,
      repositoryFullName: "owner/repo",
      senderLogin: "alice",
      status: "received",
    })
  })

  test("acknowledges duplicate deliveries without storing a second record", async () => {
    const guid = `route-duplicate-${crypto.randomUUID()}`
    const body = JSON.stringify({ action: "opened", repository: { full_name: "owner/repo" }, sender: { login: "a" } })

    expect((await Server.App().request(signedRequest(body, guid))).status).toBe(202)
    const duplicate = await Server.App().request(signedRequest(body, guid))

    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true })
  })

  test("rejects invalid authentication and malformed required headers without persistence", async () => {
    const guid = `route-invalid-${crypto.randomUUID()}`
    const body = JSON.stringify({ action: "opened" })
    const invalid = signedRequest(body, guid)
    invalid.headers.set("x-hub-signature-256", "sha256=" + "0".repeat(64))

    expect((await Server.App().request(invalid)).status).toBe(401)
    expect(await GitHubStore.get(guid)).toBeUndefined()

    const missingEvent = signedRequest(body, guid)
    missingEvent.headers.delete("x-github-event")
    expect((await Server.App().request(missingEvent)).status).toBe(400)
    expect(await GitHubStore.get(guid)).toBeUndefined()
  })

  test("rejects invalid JSON and an unavailable webhook secret", async () => {
    const guid = `route-json-${crypto.randomUUID()}`
    expect((await Server.App().request(signedRequest("{", guid))).status).toBe(400)
    expect(await GitHubStore.get(guid)).toBeUndefined()

    delete process.env.SYNERGY_GITHUB_WEBHOOK_SECRET
    const noSecretGuid = `route-secret-${crypto.randomUUID()}`
    expect((await Server.App().request(signedRequest("{}", noSecretGuid))).status).toBe(503)
    expect(await GitHubStore.get(noSecretGuid)).toBeUndefined()
  })
  test("rejects a signed payload that exceeds the webhook body limit", async () => {
    const guid = `route-large-${crypto.randomUUID()}`
    const body = JSON.stringify({ padding: "x".repeat(256 * 1024) })

    const response = await Server.App().request(signedRequest(body, guid))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(await GitHubStore.get(guid)).toBeUndefined()
  })
})
