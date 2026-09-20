import { expect, test } from "bun:test"
import { GlobalStorageRoute } from "../../src/server/storage-route"

test("upgrade status is available independently of history and the catalog validates bounds", async () => {
  const response = await GlobalStorageRoute.request("http://localhost/upgrade")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ready: true, pending: 0, partial: 0, imported: 0, quarantined: 0, total: 0 })
  const invalid = await GlobalStorageRoute.request("http://localhost/upgrade/sessions?limit=101")
  expect(invalid.status).toBe(400)
  const page = await GlobalStorageRoute.request("http://localhost/upgrade/sessions?limit=1")
  expect(await page.json()).toEqual({ items: [] })
})
