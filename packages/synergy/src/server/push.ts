import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { PushStore } from "../push/store"
import { PushService } from "../push/service"
import { PushTypes } from "../push/types"
import { errors } from "./error"

const ForbiddenEndpointError = z
  .object({
    message: z.string(),
  })
  .meta({ ref: "PushEndpointRejected" })

const CategoriesSchema = z
  .object({
    completion: z.boolean(),
    error: z.boolean(),
    input: z.boolean(),
  })
  .meta({ ref: "PushCategories" })

const SubscriptionSchema = z
  .object({
    id: z.string(),
    endpoint: z.string(),
    deviceLabel: z.string().optional(),
    created: z.number(),
    categories: CategoriesSchema,
  })
  .meta({ ref: "PushSubscriptionInfo" })

const SubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  deviceLabel: z.string().optional(),
  categories: CategoriesSchema.optional(),
})
export const PushRoute = new Hono()
  .get(
    "/vapid-key",
    describeRoute({
      summary: "Get the server's public Web Push VAPID key",
      description:
        "Returns the public VAPID key browsers need for PushManager.subscribe. The key pair is generated on first use.",
      operationId: "push.getVapidKey",
      responses: {
        200: {
          description: "Public VAPID key",
          content: {
            "application/json": {
              schema: resolver(z.object({ publicKey: z.string() }).meta({ ref: "PushVapidKey" })),
            },
          },
        },
      },
    }),
    async (c) => {
      const keys = await PushStore.vapidKeys()
      return c.json({ publicKey: keys.publicKey })
    },
  )
  .get(
    "/subscriptions",
    describeRoute({
      summary: "List Web Push subscriptions",
      description: "List every registered push subscription. Subscription keys are never returned.",
      operationId: "push.list",
      responses: {
        200: {
          description: "Registered subscriptions without transport keys",
          content: {
            "application/json": {
              schema: resolver(SubscriptionSchema.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const all = await PushStore.list()
      return c.json(
        all.map((s) => ({
          id: s.id,
          endpoint: s.endpoint,
          ...(s.deviceLabel !== undefined ? { deviceLabel: s.deviceLabel } : {}),
          created: s.created,
          categories: s.categories,
        })),
      )
    },
  )
  .post(
    "/subscribe",
    describeRoute({
      summary: "Register a Web Push subscription",
      description:
        "Register a browser push subscription (endpoint + encryption keys). Re-subscribing with the same endpoint updates it in place.",
      operationId: "push.subscribe",
      responses: {
        200: {
          description: "Subscription stored",
          content: {
            "application/json": {
              schema: resolver(SubscriptionSchema),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", SubscribeBody),
    async (c) => {
      const body = c.req.valid("json")
      if (!PushTypes.isAllowedPushEndpoint(body.endpoint)) {
        return c.json(ForbiddenEndpointError.parse({ message: "Push endpoint is not an allowed push service" }), 400)
      }
      const stored = await PushStore.upsert(body)
      return c.json({
        id: stored.id,
        endpoint: stored.endpoint,
        ...(stored.deviceLabel !== undefined ? { deviceLabel: stored.deviceLabel } : {}),
        created: stored.created,
        categories: stored.categories,
      })
    },
  )
  .post(
    "/unsubscribe",
    describeRoute({
      summary: "Remove a Web Push subscription",
      description: "Remove the subscription matching the given push endpoint.",
      operationId: "push.unsubscribe",
      responses: {
        200: {
          description: "Subscription removed (idempotent)",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", z.object({ endpoint: z.string().url() })),
    async (c) => {
      const body = c.req.valid("json")
      if (!PushTypes.isAllowedPushEndpoint(body.endpoint)) {
        return c.json(ForbiddenEndpointError.parse({ message: "Push endpoint is not an allowed push service" }), 400)
      }
      await PushStore.removeByEndpoint(body.endpoint)
      return c.json(true)
    },
  )
  .post(
    "/test",
    describeRoute({
      summary: "Send a test Web Push notification",
      description: "Send one test notification to verify an existing subscription end to end.",
      operationId: "push.test",
      responses: {
        200: {
          description: "Test notification dispatched",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", z.object({ endpoint: z.string().url().optional() })),
    async (c) => {
      const body = c.req.valid("json")
      if (body.endpoint && !PushTypes.isAllowedPushEndpoint(body.endpoint)) {
        return c.json(ForbiddenEndpointError.parse({ message: "Push endpoint is not an allowed push service" }), 400)
      }
      if (body.endpoint) {
        const existing = await PushStore.findByEndpoint(body.endpoint)
        if (!existing) return c.json({ message: "Unknown subscription endpoint" }, 404)
      }
      await PushService.send({
        title: "Synergy push test",
        body: "If you can read this, device push is working.",
        href: "/",
        tag: "push-test",
        category: "test",
      })
      return c.json(true)
    },
  )
  .patch(
    "/subscriptions/:id/categories",
    describeRoute({
      summary: "Update push category preferences for one subscription",
      description: "Enable or disable completion/error/input pushes per subscribed device.",
      operationId: "push.updateCategories",
      responses: {
        200: {
          description: "Categories updated",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        404: {
          description: "Unknown subscription id",
          content: {
            "application/json": {
              schema: resolver(z.object({ message: z.string() })),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "param",
      z.object({
        id: z.string(),
      }),
    ),
    validator("json", CategoriesSchema),
    async (c) => {
      const { id } = c.req.valid("param")
      const existing = await PushStore.list()
      if (!existing.some((s) => s.id === id)) {
        return c.json({ message: "Unknown subscription id" }, 404)
      }
      await PushStore.updateCategories(id, c.req.valid("json"))
      return c.json(true)
    },
  )
