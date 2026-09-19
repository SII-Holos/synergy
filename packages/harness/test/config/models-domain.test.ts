import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Info } from "../../src/config/schema"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

async function storedModels(): Promise<Record<string, unknown>> {
  const filepath = ConfigDomain.filepath("models")
  const file = Bun.file(filepath)
  if (!(await file.exists())) return {}
  return JSON.parse(await file.text())
}

describe("models domain nullable role clear", () => {
  test("schema accepts explicit null for role model strings and role_variant values", () => {
    expect(Info.safeParse({ model: null }).success).toBe(true)
    expect(Info.safeParse({ nano_model: null }).success).toBe(true)
    expect(Info.safeParse({ role_variant: { default: null } }).success).toBe(true)
  })

  test("explicit null clears a stored role model and role variant with sibling preservation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Config.domainUpdate("models", {
          model: "anthropic/claude-sonnet-4-5",
          role_variant: { default: "high", title: "low" },
        })
        expect(await Config.domainGet("models")).toMatchObject({
          model: "anthropic/claude-sonnet-4-5",
          role_variant: { default: "high", title: "low" },
        })

        await Config.domainUpdate("models", { model: null, role_variant: { default: null } })

        // The explicit-null marker persists as unset and the untouched
        // sibling variant survives the merge.
        expect(await storedModels()).toMatchObject({
          model: null,
          role_variant: { default: null, title: "low" },
        })

        // Readers resolve the cleared role to unset.
        const current = await Config.current()
        expect(current.model).toBeUndefined()
        expect(current.role_variant).toEqual({ title: "low" })
      },
    })
  })

  test("current() normalizes stored null role fields to unset", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".synergy/synergy.d/10-models.jsonc"),
          JSON.stringify({ model: null, vision_model: null, role_variant: { title: null } }),
        )
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.current()
        expect(config.model).toBeUndefined()
        expect(config.vision_model).toBeUndefined()
        expect(config.role_variant).toBeUndefined()
      },
    })
  })
})
