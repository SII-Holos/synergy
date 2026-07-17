import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { ConfigRoute } from "../../src/server/config-route"

let originalGeneralConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined

function app() {
  return new Hono().route("/config", ConfigRoute)
}

function patchGeneral(config: unknown) {
  return app().request("/config/domains/general", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  })
}

afterEach(async () => {
  if (!originalGeneralConfig) return
  await Config.domainUpdate("general", originalGeneralConfig, { mode: "replace-domain" })
  originalGeneralConfig = undefined
})

describe.serial("global General config route locale", () => {
  test("accepts every supported locale preference", async () => {
    originalGeneralConfig = await Config.domainGet("general")

    for (const locale of ["system", "en", "zh-CN"] as const) {
      const response = await patchGeneral({ locale })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ locale })
      expect(await Config.domainGet("general")).toMatchObject({ locale })
    }
  })

  test("rejects unsupported locale preferences without updating config", async () => {
    originalGeneralConfig = await Config.domainGet("general")
    await Config.domainUpdate("general", { ...originalGeneralConfig, locale: "en" }, { mode: "replace-domain" })

    for (const locale of ["", "fr", "de-DE"]) {
      const response = await patchGeneral({ locale })
      expect(response.status).toBe(400)
      expect(await Config.domainGet("general")).toMatchObject({ locale: "en" })
    }
  })
})
