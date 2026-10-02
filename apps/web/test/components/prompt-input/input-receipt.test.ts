import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import { createSynergyClient, type SessionInputProgress } from "@ericsanchezok/synergy-sdk/client"
import { recoverSessionInputReceipt } from "../../../src/components/prompt-input/input-receipt"

const target = { sessionID: "session", messageID: "message" }
const admitted: SessionInputProgress = { ...target, state: "running", durable: true, canonical: true, updatedAt: 1 }
let response = {
  status: 200,
  data: admitted as unknown,
}
const requests: { path: string; scope: string | null }[] = []
const server = createServer((request, reply) => {
  reply.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*")
  reply.setHeader("Access-Control-Allow-Headers", "x-synergy-scope-id")
  reply.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  if (request.method === "OPTIONS") {
    reply.writeHead(204)
    reply.end()
    return
  }
  requests.push({ path: request.url ?? "", scope: request.headers["x-synergy-scope-id"]?.toString() ?? null })
  reply.writeHead(response.status, { "Content-Type": "application/json" })
  reply.end(JSON.stringify(response.data))
})
let client: ReturnType<typeof createSynergyClient>
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address")
  client = createSynergyClient({ baseUrl: `http://127.0.0.1:${address.port}`, scopeID: "fixture-scope" })
})
afterAll(async () => {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

test("a lost receipt recovers durable admission through the scoped generated client", async () => {
  expect(await recoverSessionInputReceipt(client, target)).toEqual({ kind: "accepted", progress: admitted })
  expect(requests).toEqual([{ path: "/session/session/input/message/status", scope: "fixture-scope" }])
})

test("failed durable materialization remains admitted for its existing recovery owner", async () => {
  const progress: SessionInputProgress = {
    ...target,
    state: "failed",
    durable: true,
    canonical: false,
    updatedAt: 2,
    itemID: "item",
    error: { code: "StorageError", message: "Retry saved input" },
  }
  response = { status: 200, data: progress }
  expect(await recoverSessionInputReceipt(client, target)).toEqual({ kind: "accepted", progress })
})

test("unavailable or mismatched progress cannot confirm admission or erase the submitted message", async () => {
  response = { status: 503, data: { name: "RuntimeShuttingDownError", data: { message: "Unavailable" } } }
  expect(await recoverSessionInputReceipt(client, target)).toEqual({ kind: "uncertain" })
  response = {
    status: 200,
    data: { ...target, messageID: "foreign", state: "running", durable: true, canonical: true, updatedAt: 3 },
  }
  expect(await recoverSessionInputReceipt(client, target)).toEqual({ kind: "uncertain" })
})

test("a missing durable record permits ordinary failed-submit recovery", async () => {
  response = { status: 404, data: { name: "NotFoundError", data: { message: "Input was not found" } } }
  expect(await recoverSessionInputReceipt(client, target)).toEqual({ kind: "missing" })
})
