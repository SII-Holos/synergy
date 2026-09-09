import { Format } from "@ericsanchezok/synergy-agent-integrations/format"
import { GithubIdentityRoute } from "@ericsanchezok/synergy-connections/github/routes"
import {
  BrowserRoute,
  configureBrowserViewerOrigins,
} from "@ericsanchezok/synergy-browser-runtime/routes/browser-route"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ComputerRoute } from "@ericsanchezok/synergy-computer-runtime/routes/computer-route"
import { ManagedProjectArchiveError } from "@ericsanchezok/synergy-connections/channel/managed-project-ownership"
import { LSP } from "@ericsanchezok/synergy-agent-integrations/lsp"
import { Vcs } from "@ericsanchezok/synergy-workbench/project/vcs"
import { GitRoute } from "@ericsanchezok/synergy-workbench/project/routes/git"
import { MCP } from "@ericsanchezok/synergy-agent-integrations/mcp"
import { McpRoute } from "@ericsanchezok/synergy-agent-integrations/mcp/routes/mcp-route"
import { ChannelRoute } from "@ericsanchezok/synergy-connections/channel/routes/channel"
import { LibraryRoute } from "@ericsanchezok/synergy-library/routes/library"
import { SessionAgendaRoute } from "@ericsanchezok/synergy-workflows/agenda/routes/session-agenda"
import { AgendaRoute } from "@ericsanchezok/synergy-workflows/agenda/routes/agenda"
import { NoteRoute } from "@ericsanchezok/synergy-note/routes/note"
import { VoiceRoute } from "@ericsanchezok/synergy-media/voice/routes/voice-route"
import { PluginRoute, ApiPluginRoute } from "@ericsanchezok/synergy-plugin-host/plugin/routes/plugin-routes"
import { PluginRuntimeRoute } from "@ericsanchezok/synergy-plugin-host/plugin-runtime/routes/plugin-runtime-routes"
import { RegistryRoute } from "@ericsanchezok/synergy-plugin-host/plugin/routes/plugin-registry-routes"
import { StatsRoute } from "@ericsanchezok/synergy-workbench/stats/routes/stats"
import { AgendaStore, AgendaTypes, AgendaWebhook } from "@ericsanchezok/synergy-workflows/agenda"
import { HolosRoute, HolosDataRoute } from "@ericsanchezok/synergy-connections/holos/routes/holos"
import { GlobalNavRoute } from "./global-nav"
import { BrowserHostBrokerProcess } from "@ericsanchezok/synergy-browser-runtime/host-broker-process"
import { BlueprintRoute } from "@ericsanchezok/synergy-workflows/blueprint/routes/blueprint"
import { LatticeRoute } from "@ericsanchezok/synergy-workflows/lattice/routes/lattice"
import { WorkflowRoute } from "@ericsanchezok/synergy-workflows/routes/workflow"
import { BossRoute } from "@ericsanchezok/synergy-workflows/boss/routes/boss"
import { PerformanceRoute } from "@ericsanchezok/synergy-workbench/performance/routes/performance-route"
import { SynergyLinkRoute } from "@ericsanchezok/synergy-agent-integrations/synergy-link/routes/synergy-link-route"
import { PushRoute } from "@ericsanchezok/synergy-workbench/push/routes/push"
import { resolveAppStaticRequest } from "./app-static"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { errors } from "@ericsanchezok/synergy-server/server/error"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import * as fs from "node:fs"
import path from "node:path"

const APP_DIST = (() => {
  const fromExec = path.resolve(path.dirname(fs.realpathSync(process.execPath)), "../app")
  if (fs.existsSync(fromExec)) return fromExec
  return path.resolve(import.meta.dirname, "../../../../apps/web/dist")
})()

function mountApp(app: Hono) {
  app
    .use("/*", async (c, next) => {
      const reqPath = decodeURI(new URL(c.req.url).pathname)

      const serveFile = (resolved: string, immutable?: boolean) => {
        const file = Bun.file(resolved)
        if (immutable) c.header("Cache-Control", "public, immutable, max-age=31536000")
        else if (path.extname(resolved) === ".html") c.header("Cache-Control", "no-cache")
        c.header("Content-Security-Policy", Server.spaCsp())
        return c.body(file.stream(), { headers: { "Content-Type": file.type || "application/octet-stream" } })
      }

      const resolved = await resolveAppStaticRequest(APP_DIST, reqPath)
      if (resolved.type === "file") return serveFile(resolved.path, resolved.immutable)
      if (resolved.type === "missing") return c.notFound()
      return next()
    })
    .get("/*", async (c) => {
      const file = Bun.file(path.join(APP_DIST, "index.html"))
      if (await file.exists().catch(() => false)) {
        const html = await file.text()
        const reqPath = new URL(c.req.url).pathname
        const routeTag = `<script>window.__SYNERGY_ROUTE__=${JSON.stringify(reqPath)}</script>`
        c.header("Cache-Control", "no-cache")
        c.header("Content-Security-Policy", Server.spaCsp())
        const rendered = html.includes("<head>")
          ? html.replace("<head>", `<head>\n${routeTag}`)
          : html.includes("</head>")
            ? html.replace("</head>", `${routeTag}\n</head>`)
            : routeTag + html
        return c.body(rendered, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      }
      return c.notFound()
    })
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

let registered = false

export function registerProductRoutes() {
  if (registered) return
  Server.registerContributions({
    providerRoutes: GithubIdentityRoute,
    scopeConflictSchema: ManagedProjectArchiveError.Schema,
    bootstrap: {
      mcp: { schema: z.record(z.string(), MCP.Status), load: () => MCP.status() },
      agenda: { schema: AgendaTypes.Item.array(), load: () => AgendaStore.listForScope(ScopeContext.current.scope.id) },
      lsp: { schema: LSP.Status.array(), load: () => LSP.status(), projectOnly: true },
      vcs: {
        schema: Vcs.Info,
        load: () => Vcs.branch().then((branch) => ({ branch: branch ?? "" })),
        projectOnly: true,
      },
    },
    routes: {
      "global-tools": new Hono().route("/global/git", GitRoute).route("/global/stats", StatsRoute),
      "global-performance": new Hono().route("/global", PerformanceRoute),
      "global-services": new Hono()
        .route("/holos", HolosRoute)
        .route("/push", PushRoute)
        .route("/synergy-link", SynergyLinkRoute)
        .get(
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
      "global-navigation": new Hono().route("/global", GlobalNavRoute).post(
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
      "scoped-version-control": new Hono().route("/session", SessionAgendaRoute).get(
        "/vcs",
        describeRoute({
          summary: "Get VCS info",
          description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
          operationId: "vcs.get",
          responses: {
            200: {
              description: "VCS info",
              content: {
                "application/json": {
                  schema: resolver(Vcs.Info),
                },
              },
            },
          },
        }),
        async (c) => {
          const branch = await Vcs.branch()
          return c.json({
            branch,
          })
        },
      ),
      "scoped-before-assets": new Hono()
        .route("/library", LibraryRoute)
        .route("/agenda", AgendaRoute)
        .route("/note", NoteRoute)
        .route("/blueprint", BlueprintRoute)
        .route("/lattice", LatticeRoute)
        .route("/workflow", WorkflowRoute)
        .route("/boss", BossRoute),
      "scoped-after-assets": new Hono()
        .route("/voice", VoiceRoute)
        .route("/holos", HolosDataRoute)
        .route("", BrowserRoute)
        .route("", ComputerRoute)
        .route("/plugin", PluginRoute)
        .route("/api/plugins", ApiPluginRoute)
        .route("/api/plugins", PluginRuntimeRoute)
        .route("/api/registry", RegistryRoute),
      "scoped-integrations": new Hono()
        .route("/mcp", McpRoute)
        .route("/channel", ChannelRoute)

        .get(
          "/experimental/resource",
          describeRoute({
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
            operationId: "experimental.resource.list",
            responses: {
              200: {
                description: "MCP resources",
                content: {
                  "application/json": {
                    schema: resolver(z.record(z.string(), MCP.Resource)),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await MCP.resources())
          },
        )
        .get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        )
        .get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        ),
    },
    isGlobalRoute: (pathname) =>
      pathname === "/plugin/ui/contributions/themes" ||
      matchesPath(pathname, ["/holos", "/synergy-link", "/channel", "/plugin/assets", "/api/plugins", "/api/registry"]),
    isScopeRequiredRoute: (pathname) =>
      matchesPath(pathname, [
        "/voice",
        "/vcs",
        "/note",
        "/blueprint",
        "/lattice",
        "/workflow",
        "/boss",
        "/lsp",
        "/formatter",
      ]),
    errorStatus: (error) => {
      if (error instanceof ManagedProjectArchiveError) return 409
      if (error.name === "ChannelStartError") return 400
    },
    mountApp,
    configureOrigins: configureBrowserViewerOrigins,
    listening: (url) => BrowserHostBrokerProcess.configureServerUrl(url.toString()),
  })
  registered = true
}
