import { describe, expect, test, mock } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { ScopeContext } from "../../src/scope/context"
import { Plugin } from "../../src/plugin"
import { Skill } from "../../src/skill"
import { tmpdir } from "../fixture/fixture"

describe.serial("skill route", () => {
  test("lists valid skills and diagnostics for broken ones", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".synergy", "skill", "valid-skill", "SKILL.md"),
          `---
name: valid-skill
description: Valid skill.
---

# Valid Skill
`,
        )
        await Bun.write(
          path.join(dir, ".synergy", "skill", "broken-skill", "SKILL.md"),
          `---
name: broken-skill
description: bad: yaml: here
---

# Broken Skill
`,
        )
      },
    })

    const app = Server.App()
    const response = await app.request(`/skill?directory=${encodeURIComponent(tmp.path)}`, { method: "GET" })
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(Array.isArray(data.items)).toBe(true)
    expect(Array.isArray(data.diagnostics)).toBe(true)
    expect(data.items.some((item: any) => item.name === "valid-skill")).toBe(true)
    expect(data.items.some((item: any) => item.name === "broken-skill")).toBe(false)
    expect(data.diagnostics.some((item: any) => item.name === "broken-skill")).toBe(true)
  })

  test("lists plugin skill metadata and prevents deleting plugin skills", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as any).skillEntries = mock(async () => [
      {
        name: "plugin-route-skill",
        description: "Plugin route skill.",
        content: "# Plugin Route Skill",
        pluginId: "route-plugin",
        pluginName: "Route Plugin",
        pluginDir: path.join(tmp.path, "route-plugin"),
      },
    ])

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const app = Server.App()
          const response = await app.request(`/skill?directory=${encodeURIComponent(tmp.path)}`, { method: "GET" })
          expect(response.status).toBe(200)
          const data = await response.json()
          const skill = data.items.find((item: any) => item.name === "plugin-route-skill")
          expect(skill).toBeDefined()
          expect(skill.source).toBe("plugin")
          expect(skill.scope).toBe("external")
          expect(skill.pluginId).toBe("route-plugin")
          expect(skill.pluginName).toBe("Route Plugin")

          const deleteResponse = await app.request(
            `/skill/plugin-route-skill?directory=${encodeURIComponent(tmp.path)}`,
            {
              method: "DELETE",
            },
          )
          expect(deleteResponse.status).toBe(400)
          const deleteData = await deleteResponse.json()
          expect(deleteData.error).toBe("Cannot delete plugin skills")
          expect(deleteData.pluginId).toBe("route-plugin")
        },
      })
    } finally {
      ;(Plugin as any).skillEntries = originalSkillEntries
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
        },
      })
    }
  })
})
