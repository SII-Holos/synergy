import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "../../src/config/config"
import { ConfigRoute } from "../../src/server/config-route"
import { Channel } from "../../src/channel"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

let originalGeneralConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
let originalChannelsConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined
const originalChannelReload = Channel.reload

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

function patchChannels(config: unknown) {
  return ScopeContext.provide({
    scope: Scope.home(),
    fn: () =>
      app().request("/config/domains/channels", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      }),
  })
}

afterEach(async () => {
  Channel.reload = originalChannelReload
  if (originalGeneralConfig) {
    await Config.domainUpdate("general", originalGeneralConfig, { mode: "replace-domain" })
    originalGeneralConfig = undefined
  }
  if (originalChannelsConfig) {
    await Config.domainUpdate("channels", originalChannelsConfig, { mode: "replace-domain" })
    originalChannelsConfig = undefined
  }
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

describe.serial("global Channels config route runtime reload", () => {
  test("reloads Channel after persisting a Channel domain update", async () => {
    originalChannelsConfig = await Config.domainGet("channels")
    const channelReload = mock(async () => {})
    Channel.reload = channelReload as typeof Channel.reload

    const response = await patchChannels({
      channel: {
        clarus: {
          type: "clarus",
          accounts: { agent: { enabled: true } },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(channelReload).toHaveBeenCalledTimes(1)
  })
})
