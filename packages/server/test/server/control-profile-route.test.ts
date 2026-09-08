import { expect, test } from "bun:test"
import { Hono } from "hono"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ControlProfileRoute } from "../../src/server/control-profile-route"

const app = new Hono().route("/", ControlProfileRoute)

test("control profile routes resolve configured and per-agent policy while exposing all standard profiles", async () => {
  await using tmp = await tmpdir({
    config: { controlProfile: "autonomous", agent: { researcher: { controlProfile: "full_access" } } },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const response = await app.request("/control-profiles")
      expect(response.status).toBe(200)
      const profiles = (await response.json()) as Array<{ id: string; label: string; description: string }>
      expect(profiles.map((item) => item.id).sort()).toEqual(["autonomous", "full_access", "guarded"])
      expect(profiles.every((item) => item.description && item.label)).toBe(true)
      const configured = await app.request("/control-profiles/effective")
      expect(await configured.json()).toMatchObject({
        profileId: "autonomous",
        source: "config",
        configProfile: "autonomous",
      })
      const agent = await app.request("/control-profiles/effective?agent=researcher")
      expect(await agent.json()).toMatchObject({ profileId: "full_access", source: "agent", agentName: "researcher" })
      const missing = await app.request("/control-profiles/effective?agent=missing-route-test-agent")
      expect(missing.status).toBe(400)
      expect(await missing.json()).toEqual({ error: 'Agent "missing-route-test-agent" not found' })
      const sandbox = await app.request("/sandbox/status")
      const status = (await sandbox.json()) as Record<string, unknown>
      expect(sandbox.status).toBe(200)
      expect(typeof status.platform).toBe("string")
      expect(typeof status.available).toBe("boolean")
      expect(typeof status.supported).toBe("boolean")
    },
  })
})

test("control profile route uses guarded when neither config nor agent supplies an override", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      expect(await (await app.request("/control-profiles/effective")).json()).toMatchObject({
        profileId: "guarded",
        source: "default",
      })
    },
  })
})
