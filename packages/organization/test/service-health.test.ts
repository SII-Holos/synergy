import { expect, test } from "bun:test"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { fixture } from "./support/organization"

test("service liveness stays independent of maintenance while readiness retains its declared wire response", async () => {
  const browserOrigin = "https://work.example"
  await using f = await fixture(undefined, {
    clientAuthentication: {
      clients: [{ clientID: "health-web", kind: "web", redirectUri: `${browserOrigin}/organization/callback` }],
    },
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.service.fetch, websocket: f.service.websocket })
  const request = (path: string) => fetch(`${server.url}org/v1/${path}`, { headers: { origin: browserOrigin } })
  try {
    const live = await request("live")
    expect(live.status).toBe(200)
    expect(live.headers.get("cache-control")).toBe("no-store")
    expect(live.headers.get("access-control-allow-origin")).toBe(browserOrigin)
    expect(await live.json()).toEqual({ alive: true, protocolVersion: 1 })
    expect((await request("ready")).status).toBe(200)
    const lease = await f.service.maintenance.run(() =>
      RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "health-maintenance",
        actor: {
          kind: "system",
          subjectID: "operator",
          displayName: "Operator",
          clientKind: "system",
          requestID: "health-maintenance",
        },
      }),
    )
    await f.service.maintenance.run(async () => {
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    })
    expect((await request("live")).status).toBe(200)
    for (const path of ["ready", "health"]) {
      const response = await request(path)
      expect(response.status).toBe(503)
      expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin)
      expect(await response.json()).toEqual({ ready: false, protocolVersion: 1 })
    }
    const head = await fetch(`${server.url}org/v1/ready`, { method: "HEAD" })
    expect(head.status).toBe(503)
    expect(await head.text()).toBe("")
    await f.service.maintenance.run(() => RuntimeMaintenance.release(lease))
    const ready = await request("ready")
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ ready: true, protocolVersion: 1 })
    await f.service.close()
    for (const path of ["live", "ready"]) {
      const response = await request(path)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual(
        path === "live" ? { alive: false, protocolVersion: 1 } : { ready: false, protocolVersion: 1 },
      )
    }
  } finally {
    await server.stop(true)
  }
})
