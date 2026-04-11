import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const registerProvidersMock = mock(() => {})
const channelStartMock = mock(async () => {})
const channelReloadMock = mock(async () => {})
const channelStatusMock = mock(async () => ({ status: "connected" as const }))
const configReloadMock = mock(async () => ({ config: {}, changedFields: ["channel"] }))

mock.module("../../src/channel/provider", () => ({
  registerProviders: registerProvidersMock,
}))

const { Channel } = await import("../../src/channel")
const { Config } = await import("../../src/config/config")
const { ConfigSet } = await import("../../src/config/set")
const { Global } = await import("../../src/global")
const { Instance } = await import("../../src/scope/instance")
const { Server } = await import("../../src/server/server")
const { Log } = await import("../../src/util/log")

Log.init({ print: false })

let authBackup: string | undefined
let configBackup: string | undefined
let configPath = ""
const originalChannelStart = Channel.start
const originalChannelReload = Channel.reload
const originalChannelStatus = Channel.status
const originalConfigReload = Config.reload

async function readOptional(filepath: string) {
  return Bun.file(filepath)
    .text()
    .then((value) => value)
    .catch(() => undefined)
}

async function restoreFile(filepath: string, contents: string | undefined) {
  if (contents === undefined) {
    await fs.rm(filepath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, contents)
}

describe("channel api", () => {
  beforeEach(async () => {
    configPath = ConfigSet.filePath(ConfigSet.activeNameSync())
    authBackup = await readOptional(Global.Path.authApiKey)
    configBackup = await readOptional(configPath)

    await fs.mkdir(path.dirname(Global.Path.authApiKey), { recursive: true })
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await Bun.write(Global.Path.authApiKey, "{}\n")
    await Bun.write(configPath, "{}\n")

    registerProvidersMock.mockClear()
    channelStartMock.mockClear()
    channelReloadMock.mockClear()
    channelStatusMock.mockClear()
    configReloadMock.mockClear()

    Channel.start = channelStartMock as typeof Channel.start
    Channel.reload = channelReloadMock as typeof Channel.reload
    Channel.status = channelStatusMock as unknown as typeof Channel.status
    Config.reload = configReloadMock as typeof Config.reload

    await Instance.disposeAll()
  })

  afterEach(async () => {
    Channel.start = originalChannelStart
    Channel.reload = originalChannelReload
    Channel.status = originalChannelStatus
    Config.reload = originalConfigReload

    await restoreFile(Global.Path.authApiKey, authBackup)
    await restoreFile(configPath, configBackup)
    await Instance.disposeAll()
  })

  test("start-one reloads global config before starting channel", async () => {
    const app = Server.App()
    const response = await app.request("/channel/feishu/default/start", { method: "POST" })

    expect(response.status).toBe(200)
    expect(registerProvidersMock).toHaveBeenCalledTimes(1)
    expect(configReloadMock).toHaveBeenCalledWith("global")
    expect(channelStartMock).toHaveBeenCalledWith("feishu", "default")
    expect(channelReloadMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ "feishu:default": { status: "connected" } })
  })

  test("start-all reloads global config and channels", async () => {
    const app = Server.App()
    const response = await app.request("/channel/start", { method: "POST" })

    expect(response.status).toBe(200)
    expect(registerProvidersMock).toHaveBeenCalledTimes(1)
    expect(configReloadMock).toHaveBeenCalledWith("global")
    expect(channelReloadMock).toHaveBeenCalledTimes(1)
    expect(channelStartMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ "feishu:default": { status: "connected" } })
  })

  test("start-one returns readable 400 when channel start fails predictably", async () => {
    Channel.start = (async () => {
      throw new Channel.StartError({
        message: "Unknown channel provider: feishu",
        channelType: "feishu",
        accountId: "default",
      })
    }) as typeof Channel.start

    const app = Server.App()
    const response = await app.request("/channel/feishu/default/start", { method: "POST" })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      name: "ChannelStartError",
      data: {
        message: "Unknown channel provider: feishu",
        channelType: "feishu",
        accountId: "default",
      },
    })
  })
})
