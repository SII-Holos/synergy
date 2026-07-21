import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"

afterEach(async () => {
  await Storage.removeTree(StoragePath.synergyLinkTargetsRoot())
})

describe("Synergy Link target routes", () => {
  test("creates, lists, updates, and removes persisted targets", async () => {
    const createdResponse = await Server.App().request("/synergy-link/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Build Mac", targetAgentID: "agent_build", linkID: "link_build" }),
    })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json()
    expect(created).toEqual(
      expect.objectContaining({ name: "Build Mac", targetAgentID: "agent_build", linkID: "link_build" }),
    )

    const listResponse = await Server.App().request("/synergy-link/targets")
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toEqual([
      expect.objectContaining({ id: created.id, availability: "holos_offline" }),
    ])

    const updateResponse = await Server.App().request(`/synergy-link/targets/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Primary Builder", enabled: false }),
    })
    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toEqual(expect.objectContaining({ name: "Primary Builder", enabled: false }))

    const removeResponse = await Server.App().request(`/synergy-link/targets/${created.id}`, { method: "DELETE" })
    expect(removeResponse.status).toBe(200)
    expect(await removeResponse.json()).toEqual({ success: true })
    expect(await (await Server.App().request("/synergy-link/targets")).json()).toEqual([])
  })

  test("rejects malformed target locators", async () => {
    const response = await Server.App().request("/synergy-link/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad target", targetAgentID: "agent_bad", linkID: ":local" }),
    })
    expect(response.status).toBe(400)
  })
})
