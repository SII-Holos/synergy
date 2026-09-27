import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionAgendaRoute } from "./agenda/routes/session-agenda"
import { AgendaRoute } from "./agenda/routes/agenda"
import { AgendaStore } from "./agenda"
import { AgendaTypes } from "./agenda"
import { AgendaWebhook } from "./agenda"
import { BlueprintRoute } from "./blueprint/routes/blueprint"
import { LatticeRoute } from "./lattice/routes/lattice"
import { WorkflowRoute } from "./routes/workflow"
import { BossRoute } from "./boss/routes/boss"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { errors } from "@ericsanchezok/synergy-server/server/error"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { resolver } from "hono-openapi"
import { validator } from "hono-openapi"
import { z } from "zod"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "global-services": new Hono().get(
          "/global/agenda",
          describeRoute({
            summary: "List all agenda items across scopes",
            description: "List all agenda items from every scope, sorted by creation time descending.",
            operationId: "global.agenda.list",
            responses: {
              200: {
                description: "List of agenda items from all scopes",
                content: { "application/json": { schema: resolver(AgendaTypes.Item.array()) } },
              },
              ...errors(400),
            },
          }),
          async (c) => {
            try {
              const items = await AgendaStore.listAll()
              return c.json(items)
            } catch (err) {
              return c.json({ message: err instanceof Error ? err.message : String(err) }, 400)
            }
          },
        ),
        "global-navigation": new Hono().post(
          "/agenda/webhook/:token",
          describeRoute({
            summary: "Fire agenda webhook",
            description:
              "Trigger an agenda item via its webhook token. The request body is passed as the signal payload.",
            operationId: "agenda.webhook",
            responses: {
              200: {
                description: "Webhook accepted",
                content: {
                  "application/json": {
                    schema: resolver(z.object({ accepted: z.boolean() }).meta({ ref: "AgendaWebhookResult" })),
                  },
                },
              },
              404: {
                description: "Unknown webhook token",
                content: {
                  "application/json": {
                    schema: resolver(z.object({ message: z.string() })),
                  },
                },
              },
            },
          }),
          validator("param", z.object({ token: z.string().meta({ description: "Webhook secret token" }) })),
          async (c) => {
            const { token } = c.req.valid("param")
            const raw = await c.req.json().catch(() => ({}))
            const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : { value: raw }
            const accepted = await AgendaWebhook.fire(token, body)
            if (!accepted) return c.json({ message: "Unknown webhook token" }, 404)
            return c.json({ accepted: true })
          },
        ),
        "scoped-version-control": new Hono().route("/session", SessionAgendaRoute()),
        "scoped-before-assets": new Hono()
          .route("/agenda", AgendaRoute())
          .route("/blueprint", BlueprintRoute())
          .route("/lattice", LatticeRoute())
          .route("/workflow", WorkflowRoute())
          .route("/boss", BossRoute()),
      },
      bootstrap: {
        agenda: {
          schema: AgendaTypes.Item.array(),
          load: () => AgendaStore.listForScope(ScopeContext.current.scope.id),
        },
      },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/blueprint", "/lattice", "/workflow", "/boss"]),
    },
    "workflows",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
