import { expect, test } from "bun:test"
import { DockerEngine } from "../../src/environment/docker-engine"
import { ExecutionConnection } from "../../src/environment/connection"
import { RemoteExecutor } from "../../src/environment/remote-executor"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"

test("custom Engine transport preserves version negotiation and never falls back", async () => {
  const received: Array<{ route: string; body: unknown }> = []
  const engine = new DockerEngine({
    endpoint: "http://127.0.0.1:1",
    transport: async (request) => {
      expect(request.redirect).toBe("error")
      expect(request.signal.aborted).toBe(false)
      received.push({ route: new URL(request.url).pathname, body: request.body ? await request.json() : undefined })
      if (new URL(request.url).pathname === "/version") return Response.json({ ApiVersion: "1.45" })
      return Response.json({ Id: "owned" }, { status: 201 })
    },
  })
  expect((await engine.request("POST", "/containers/create", { Image: "fixed" })).status).toBe(201)
  expect(received).toEqual([
    { route: "/version", body: undefined },
    { route: "/v1.45/containers/create", body: { Image: "fixed" } },
  ])
  const unavailable = new DockerEngine({
    endpoint: "http://127.0.0.1:1",
    transport: async () => {
      throw new Error("transport-unavailable")
    },
  })
  await expect(unavailable.request("GET", "/info")).rejects.toThrow("transport-unavailable")
})

test("custom Executor transport retains exact target, authentication and binary bytes", async () => {
  const target = { environmentID: "environment", allocationID: "allocation", generation: 2 }
  const connection = new ExecutionConnection({
    url: "http://127.0.0.1:1",
    token: "synthetic-credential",
    target,
    transport: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-credential")
      expect(JSON.parse(request.headers.get("x-synergy-target")!)).toEqual(target)
      expect(request.headers.get("content-type")).toBe("application/octet-stream")
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([0, 255, 13]))
      return new Response(null, { status: 204 })
    },
  })
  expect((await connection.send("PUT", "/v1/binary", new Uint8Array([0, 255, 13]), true))?.status).toBe(204)
})

test("custom Executor transport carries caller cancellation and validates protocol", async () => {
  const target = { environmentID: "environment", allocationID: "allocation", generation: 2 }
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const connection = new ExecutionConnection({
    url: "http://127.0.0.1:1",
    token: "synthetic-credential",
    target,
    transport: (request) => {
      entered.resolve()
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    },
  })
  const pending = connection.send("GET", "/v1/status", undefined, false, controller.signal)
  await entered.promise
  controller.abort(new Error("caller-canceled"))
  await expect(pending).rejects.toThrow("caller-canceled")
  const remote = new RemoteExecutor({
    url: "http://127.0.0.1:1",
    token: "synthetic-credential",
    target,
    transport: async () => Response.json({ version: ExecutionProtocol.version - 1, target }),
  })
  await expect(remote.health()).rejects.toThrow()
})
