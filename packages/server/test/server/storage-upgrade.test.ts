import { expect, test } from "bun:test"
import { GlobalStorageRoute } from "../../src/server/storage-route"

test("upgrade status is available independently of history and the catalog validates bounds", async () => {
  const response = await GlobalStorageRoute.request("http://localhost/upgrade")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ready: true,
    historyReady: true,
    paused: false,
    backup: { complete: true },
    pending: 0,
    partial: 0,
    imported: 0,
    quarantined: 0,
    total: 0,
  })
  const invalid = await GlobalStorageRoute.request("http://localhost/upgrade/sessions?limit=101")
  expect(invalid.status).toBe(400)
  const page = await GlobalStorageRoute.request("http://localhost/upgrade/sessions?limit=1")
  expect(await page.json()).toEqual({ items: [] })
})

test("history controls validate actions and per-session preparation returns without a long request", async () => {
  const request = (action: string) =>
    GlobalStorageRoute.request("http://localhost/upgrade/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
  expect((await request("unknown")).status).toBe(400)
  expect(await (await request("pause")).json()).toMatchObject({ paused: true, pauseReason: "user", ready: true })
  expect(await (await request("resume")).json()).toMatchObject({ paused: false })
  expect(
    await (
      await GlobalStorageRoute.request("http://localhost/upgrade/sessions/new/prepare", { method: "POST" })
    ).json(),
  ).toMatchObject({ sessionID: "new", state: "ready" })
})
