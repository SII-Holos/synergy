import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import * as ChannelTypes from "../channel/types"
import { Channel } from "../channel"
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

function diagnosticFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown"
}

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
  .post(
    "/:channelType/:accountId/projects/refresh",
    describeRoute({
      summary: "Refresh channel account projects",
      description: "Discover and reconcile projects for one channel account, then return when this refresh completes.",
      operationId: "channel.refreshProjects",
      responses: {
        200: {
          description: "Refresh completed",
          content: {
            "application/json": {
              schema: resolver(z.object({ completed: z.literal(true) })),
            },
          },
        },
        500: {
          description: "Refresh failed",
          content: {
            "application/json": {
              schema: resolver(Channel.RefreshError.Schema),
            },
          },
        },
      },
    }),
    channelKeyParam,
    async (c) => {
      const { channelType, accountId } = c.req.valid("param")
      await Channel.refreshProjects(channelType, accountId)
      return c.json({ completed: true as const })
    },
  )
  .get(
    "/:channelType/:accountId/diagnostics.ndjson",
    describeRoute({
      summary: "Download channel account diagnostics",
      description: "Stream the retained diagnostics window as bounded NDJSON. Each line is a valid JSON record.",
      operationId: "channel.downloadDiagnostics",
      responses: {
        200: {
          description: "NDJSON diagnostic stream",
          content: {
            "application/x-ndjson": {
              schema: resolver(
                z.array(
                  z.object({
                    timestamp: z.number(),
                    level: z.string(),
                    message: z.string(),
                    data: z.record(z.string(), z.unknown()).optional(),
                  }),
                ),
              ),
            },
          },
        },
      },
    }),
    channelKeyParam,
    async (c) => {
      const { channelType, accountId } = c.req.valid("param")
      const { Channel } = await import("../channel")
      // Validate account/provider exists before attempting to read diagnostics
      const cfg = await Config.current()
      const channelConfig = cfg.channel?.[channelType]
      if (!channelConfig) return c.json({ error: "not found" }, 404)
      const accounts = "accounts" in channelConfig ? channelConfig.accounts : {}
      if (!(accountId in accounts)) return c.json({ error: "not found" }, 404)
      const provider = Channel.getProvider(channelType)
      if (!provider) return c.json({ error: "not found" }, 404)

      const filename = `channel-${diagnosticFilenamePart(channelType)}-${diagnosticFilenamePart(accountId)}-diagnostics.ndjson`
      const records = Channel.streamDiagnostics(channelType, accountId)
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await records.next()
            if (next.done) {
              controller.close()
              return
            }
            controller.enqueue(encoder.encode(JSON.stringify(next.value) + "\n"))
          } catch (error) {
            controller.error(error)
          }
        },
        async cancel() {
          await records.return(undefined)
        },
      })
      return c.newResponse(body, 200, {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${filename}"`,
      })
    },
  )
