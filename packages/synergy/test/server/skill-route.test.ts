import { describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

describe("skill route", () => {
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
})
