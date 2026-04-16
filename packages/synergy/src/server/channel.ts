import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import * as ChannelTypes from "../channel/types"
import { Config } from "../config/config"
import { registerProviders } from "../channel/provider"
import { Session } from "../session"
import z from "zod"

const ChannelStatusResponse = {
  200: {
    description: "Channel status",
    content: {
      "application/json": {
        schema: resolver(z.record(z.string(), ChannelTypes.Status)),
      },
    },
  },
}

const channelKeyParam = validator("param", z.object({ channelType: z.string(), accountId: z.string() }))

async function reloadGlobalChannelConfig() {
  await Config.reload("global")
}

async function reloadGlobalChannels() {
  registerProviders()
  await reloadGlobalChannelConfig()
  const { Channel } = await import("../channel")
  await Channel.reload()
  return Channel
}

export const ChannelRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "Get channel status",
      description: "Get the status of all messaging channel connections",
      operationId: "channel.status",
      responses: ChannelStatusResponse,
    }),
    async (c) => {
      const { Channel } = await import("../channel")
      return c.json(await Channel.status())
    },
  )
  .post(
    "/start",
    describeRoute({
      summary: "Start all channels",
      description:
        "Reload channel configuration and reconnect all channels. Picks up config changes and restarts any stopped channels.",
      operationId: "channel.start",
      responses: ChannelStatusResponse,
    }),
    async (c) => {
      const Channel = await reloadGlobalChannels()
      return c.json(await Channel.status())
    },
  )
  .post(
    "/stop",
    describeRoute({
      summary: "Stop all channels",
      description: "Disconnect all active channel connections",
      operationId: "channel.stop",
      responses: ChannelStatusResponse,
    }),
    async (c) => {
      const { Channel } = await import("../channel")
      await Channel.disconnectAll()
      return c.json(await Channel.status())
    },
  )
  .post(
    "/:channelType/:accountId/start",
    describeRoute({
      summary: "Start a channel",
      description: "Start or reconnect a specific channel account",
      operationId: "channel.startOne",
      responses: ChannelStatusResponse,
    }),
    channelKeyParam,
    async (c) => {
      const { channelType, accountId } = c.req.valid("param")
      registerProviders()
      await reloadGlobalChannelConfig()
      const { Channel } = await import("../channel")
      await Channel.start(channelType, accountId)
      return c.json(await Channel.status())
    },
  )
  .post(
    "/:channelType/:accountId/stop",
    describeRoute({
      summary: "Stop a channel",
      description: "Disconnect a specific channel account",
      operationId: "channel.stopOne",
      responses: ChannelStatusResponse,
    }),
    channelKeyParam,
    async (c) => {
      const { channelType, accountId } = c.req.valid("param")
      const { Channel } = await import("../channel")
      await Channel.disconnect(channelType, accountId)
      return c.json(await Channel.status())
    },
  )
  // Backward-compatible alias for /:channelType/:accountId/stop
  .post(
    "/:channelType/:accountId/disconnect",
    describeRoute({
      summary: "Disconnect channel account",
      description: "Disconnect a specific channel account. Alias for stop.",
      operationId: "channel.disconnect",
      responses: {
        200: {
          description: "Channel disconnected",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) })),
            },
          },
        },
      },
    }),
    channelKeyParam,
    async (c) => {
      const { channelType, accountId } = c.req.valid("param")
      const { Channel } = await import("../channel")
      await Channel.disconnect(channelType, accountId)
      return c.json({ success: true as const })
    },
  )
  .get(
    "/app/session",
    describeRoute({
      summary: "Get or create app channel session",
      description: "Returns the active Home session, creating one if none exists.",
      operationId: "channel.app.session",
      responses: {
        200: {
          description: "App channel session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      const { AppChannel } = await import("../channel/app")
      return c.json(await AppChannel.session())
    },
  )
  .post(
    "/app/reset",
    describeRoute({
      summary: "Reset app channel session",
      description: "Archives the current Home session. The next call to get session will create a fresh one.",
      operationId: "channel.app.reset",
      responses: {
        200: {
          description: "Session archived",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) })),
            },
          },
        },
      },
    }),
    async (c) => {
      const { AppChannel } = await import("../channel/app")
      await AppChannel.reset()
      return c.json({ success: true as const })
    },
  )
  .get(
    "/genesis/session",
    describeRoute({
      summary: "Get or create genesis channel session",
      description: "Returns the active Genesis setup session, creating one if none exists.",
      operationId: "channel.genesis.session",
      responses: {
        200: {
          description: "Genesis channel session",
          content: {
            "application/json": {
              schema: resolver(Session.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      const { GenesisChannel } = await import("../channel/genesis")
      return c.json(await GenesisChannel.session())
    },
  )
  .post(
    "/genesis/reset",
    describeRoute({
      summary: "Reset genesis channel session",
      description: "Archives the current Genesis session. The next call to get session will create a fresh one.",
      operationId: "channel.genesis.reset",
      responses: {
        200: {
          description: "Session archived",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) })),
            },
          },
        },
      },
    }),
    async (c) => {
      const { GenesisChannel } = await import("../channel/genesis")
      await GenesisChannel.reset()
      return c.json({ success: true as const })
    },
  )
