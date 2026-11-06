import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { requestSessionContinue } from "../../../src/components/prompt-input/continue-request"
import { createAbortRequestController } from "../../../src/components/prompt-input/abort-request"

function transport(handle: (request: Request) => Promise<Response>): typeof fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init)), {
    preconnect: fetch.preconnect,
  })
}

test("Continue sends the observed pause and coalesces repeated clicks while admission is pending", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const bodies: unknown[] = []
  const client = createSynergyClient({
    baseUrl: "http://fixture.invalid",
    fetch: transport(async (request) => {
      bodies.push(await request.json())
      entered.resolve()
      await release.promise
      return Response.json({ handled: true, outcome: "accepted", status: { type: "busy" } })
    }),
  })
  const pending: boolean[] = []
  const controller = createAbortRequestController({
    setPending: (value) => pending.push(value),
    request: () =>
      requestSessionContinue({
        client,
        sessionID: "session",
        requestID: "click",
        pausedSince: 5,
        unavailableMessage: "Unavailable",
      }),
  })
  const first = controller.run()
  await entered.promise
  const second = controller.run()
  expect(second).toBe(first)
  expect(bodies).toEqual([{ requestID: "click", pausedSince: 5 }])
  release.resolve()
  await first
  expect(pending).toEqual([true, false])
})

for (const outcome of ["idle", "blocked", "stale", "already_accepted"] as const) {
  test(`Continue exposes ${outcome} instead of silently accepting an ineffective action`, async () => {
    const client = createSynergyClient({
      baseUrl: "http://fixture.invalid",
      fetch: transport(async () =>
        Response.json({
          handled: outcome === "already_accepted",
          outcome,
          status: { type: "paused", reason: "aborted", since: 6 },
          reason: "State changed",
        }),
      ),
    })
    await expect(
      requestSessionContinue({
        client,
        sessionID: "session",
        requestID: "click",
        pausedSince: 5,
        unavailableMessage: "Unavailable",
      }),
    ).rejects.toThrow("State changed")
  })
}

for (const accepted of [true, false]) {
  test(`response loss checks the durable receipt without issuing another Continue (accepted=${accepted})`, async () => {
    const methods: string[] = []
    const client = createSynergyClient({
      baseUrl: "http://fixture.invalid",
      fetch: transport(async (request) => {
        methods.push(request.method)
        if (request.method === "POST") throw new Error("Connection lost")
        return Response.json({ id: "session", resume: { requestID: accepted ? "click" : "other", state: "consumed" } })
      }),
    })
    const request = requestSessionContinue({
      client,
      sessionID: "session",
      requestID: "click",
      pausedSince: 5,
      unavailableMessage: "Unavailable",
    })
    if (accepted) await request
    else await expect(request).rejects.toThrow("Connection lost")
    expect(methods).toEqual(["POST", "GET"])
  })
}
