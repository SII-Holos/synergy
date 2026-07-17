import { GitHubRuntime } from "@/github/runtime"
import { githubPayloadRecord } from "@/github/payload"
import { GitHubStore } from "@/github/store"
import { GitHubDelivery, GitHubWebhookResponse } from "@/github/types"
import { verifyGitHubSignature } from "@/github/webhook"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"

const ErrorResponse = z.object({ error: z.string() })
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

async function readWebhookBody(request: Request): Promise<Uint8Array | undefined> {
  const contentLength = request.headers.get("content-length")
  if (contentLength && Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) return undefined
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel()
        return undefined
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export const GitHubWebhookRoute = new Hono().post(
  "/webhook",
  describeRoute({
    summary: "Receive a GitHub App webhook",
    description: "Verify, deduplicate, and durably enqueue a GitHub App webhook for shadow processing.",
    operationId: "github.webhook.receive",
    responses: {
      202: {
        description: "Webhook accepted",
        content: { "application/json": { schema: resolver(GitHubWebhookResponse) } },
      },
      400: {
        description: "Malformed webhook",
        content: { "application/json": { schema: resolver(ErrorResponse) } },
      },
      401: {
        description: "Invalid webhook signature",
        content: { "application/json": { schema: resolver(ErrorResponse) } },
      },
      413: {
        description: "Webhook payload too large",
        content: { "application/json": { schema: resolver(ErrorResponse) } },
      },
      503: {
        description: "Webhook secret unavailable",
        content: { "application/json": { schema: resolver(ErrorResponse) } },
      },
    },
  }),
  async (c) => {
    const secret = process.env.SYNERGY_GITHUB_WEBHOOK_SECRET
    if (!secret) return c.json({ error: "webhook_secret_unavailable" }, 503)

    const eventType = c.req.header("x-github-event")
    const deliveryGuid = c.req.header("x-github-delivery")
    if (!eventType || !deliveryGuid) return c.json({ error: "missing_required_headers" }, 400)

    const rawBody = await readWebhookBody(c.req.raw)
    if (!rawBody) return c.json({ error: "payload_too_large" }, 413)
    if (!verifyGitHubSignature(rawBody, c.req.header("x-hub-signature-256"), secret)) {
      return c.json({ error: "invalid_signature" }, 401)
    }

    let rawPayload: unknown
    try {
      rawPayload = JSON.parse(new TextDecoder().decode(rawBody))
    } catch {
      return c.json({ error: "invalid_json" }, 400)
    }

    const payload = githubPayloadRecord(rawPayload)
    const installation = githubPayloadRecord(payload.installation)
    const repository = githubPayloadRecord(payload.repository)
    const sender = githubPayloadRecord(payload.sender)
    const installationId = typeof installation.id === "number" && installation.id > 0 ? installation.id : undefined
    const repositoryFullName = typeof repository.full_name === "string" ? repository.full_name : ""
    const senderLogin = typeof sender.login === "string" ? sender.login : ""
    const delivery = GitHubDelivery.parse({
      deliveryGuid,
      eventType,
      installationId,
      repositoryFullName,
      senderLogin,
      receivedAt: Date.now(),
      rawPayload,
      rawHeaders: {
        "x-github-event": eventType,
        "x-github-delivery": deliveryGuid,
        ...(c.req.header("x-github-hook-installation-target-id")
          ? { "x-github-hook-installation-target-id": c.req.header("x-github-hook-installation-target-id")! }
          : {}),
      },
      status: "received",
    })
    const accepted = await GitHubStore.accept(delivery)
    if (!accepted.duplicate) GitHubRuntime.notify()
    return c.json(GitHubWebhookResponse.parse({ accepted: true, duplicate: accepted.duplicate }), 202)
  },
)
