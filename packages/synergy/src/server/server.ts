import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono, type Context, type Next } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import * as fs from "fs"
import path from "path"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "../config/config"
import { ConfigSet } from "../config/set"
import { LSP } from "../lsp"
import { Format } from "../file/format"
import { Instance } from "../scope/instance"
import { Scope } from "@/scope"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Auth } from "../provider/api-key"
import { Command } from "../skill/command"
import { Global } from "../global"
import { ScopeRoute } from "./scope"
import { GitRoute } from "./git"
import { ToolRegistry } from "../tool/registry"
import { zodToJsonSchema } from "zod-to-json-schema"
import { lazy } from "../util/lazy"
import { InstanceBootstrap } from "../project/bootstrap"
import { Flag } from "../flag/flag"
import { MCP } from "../mcp"
import { Storage } from "../storage/storage"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { upgradeWebSocket, websocket } from "hono/bun"
import { errors } from "./error"
import { QuestionRoute } from "./question"
import { SessionExportRoute } from "./session-export"
import { CortexRoute } from "./cortex"
import { Installation } from "@/global/installation"
import { MDNS } from "./mdns"
import { Worktree } from "../project/worktree"
import { SessionRoute } from "./session"
import { PtyRoute } from "./pty"
import { ProviderRoute } from "./provider"
import { McpRoute } from "./mcp-route"
import { PermissionRoute } from "./permission"
import { FindRoute } from "./find"
import { FileRoute } from "./file"
import { ConfigRoute } from "./config-route"
import { ChannelRoute } from "./channel"
import { EngramRoute } from "./engram"
import { AgendaRoute } from "./agenda"
import { NoteRoute } from "./note"
import { AssetRoute } from "./asset"
import { Agenda, AgendaBootstrap, AgendaStore, AgendaTypes, AgendaWebhook } from "../agenda"
import { SkillRoute } from "./skill-route"
import { HolosRoute, HolosDataRoute } from "./holos"
import { RuntimeRoute } from "./runtime-route"
import { RuntimeReload } from "../runtime/reload"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

RuntimeReload.startAutoReload()

export namespace Server {
  export const DEFAULT_PORT = 4096
  export const DEFAULT_HOST = "localhost"
  export const DEFAULT_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`

  const log = Log.create({ service: "server" })

  const APP_DIST = (() => {
    const fromExec = path.resolve(path.dirname(fs.realpathSync(process.execPath)), "../app")
    if (fs.existsSync(fromExec)) return fromExec
    return path.resolve(import.meta.dirname, "../../../app/dist")
  })()
  let _url: URL | undefined
  let _corsWhitelist: string[] = []
  let _appMounted = false

  function isLoopbackOrigin(input: string) {
    try {
      const url = new URL(input)
      if (url.protocol !== "http:" && url.protocol !== "https:") return false
      return (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "0.0.0.0"
      )
    } catch {
      return false
    }
  }

  function isGlobalRoute(pathname: string) {
    return (
      pathname === "/global" ||
      pathname.startsWith("/global/") ||
      pathname === "/holos" ||
      pathname.startsWith("/holos/") ||
      pathname === "/channel" ||
      pathname.startsWith("/channel/")
    )
  }

  async function resolveScopedRequestScope(c: Context): Promise<Scope> {
    let directory = c.req.query("directory") || c.req.header("x-synergy-directory") || Flag.SYNERGY_CWD || process.cwd()
    try {
      directory = decodeURIComponent(directory)
    } catch {
      // fallback to original value
    }
    if (directory === "global") return Scope.global()
    return (await Scope.fromDirectory(directory)).scope
  }

  async function provideRequestScope(c: Context, next: Next) {
    const scope = isGlobalRoute(c.req.path) ? Scope.global() : await resolveScopedRequestScope(c)
    return Instance.provide({
      scope,
      init: InstanceBootstrap,
      async fn() {
        return next()
      },
    })
  }

  export function url(): URL {
    return _url ?? new URL(DEFAULT_URL)
  }

  export const Event = {
    Connected: BusEvent.define("server.connected", z.object({})),
    Disposed: BusEvent.define("global.disposed", z.object({})),
  }

  const app = new Hono()
  export const App: () => Hono = lazy(
    (): Hono =>
      app
        .onError((err, c) => {
          log.error("failed", {
            method: c.req.method,
            path: c.req.path,
            error: err,
          })
          if (err instanceof NamedError) {
            let status: ContentfulStatusCode
            if (err instanceof Storage.NotFoundError) status = 404
            else if (err instanceof Provider.ModelNotFoundError) status = 400
            else if (err.name === "ChannelStartError") status = 400
            else if (ConfigSet.NotFoundError.isInstance(err)) status = 404
            else if (
              ConfigSet.ExistsError.isInstance(err) ||
              ConfigSet.DeleteDefaultError.isInstance(err) ||
              ConfigSet.DeleteActiveError.isInstance(err) ||
              err.name.startsWith("Worktree")
            )
              status = 400
            else status = 500
            return c.json(err.toObject(), { status })
          }
          return c.json(new NamedError.Unknown({ message: "Internal server error" }).toObject(), {
            status: 500,
          })
        })
        .use(async (c, next) => {
          const reqPath = c.req.path
          const skipLogging = reqPath === "/log" || reqPath === "/global/health" || reqPath.startsWith("/assets/")
          const start = Date.now()
          const requestId = crypto.randomUUID().slice(0, 8)
          try {
            await next()
          } finally {
            if (!skipLogging) {
              log.info("request", {
                rid: requestId,
                method: c.req.method,
                path: reqPath,
                status: c.res.status,
                duration: Date.now() - start,
              })
            }
          }
        })
        .use(
          cors({
            origin(input) {
              if (!input) return

              if (isLoopbackOrigin(input)) return input

              // *.holosai.io (https only)
              if (/^https:\/\/([a-z0-9-]+\.)*holosai\.io$/.test(input)) {
                return input
              }
              if (_corsWhitelist.includes(input)) {
                return input
              }

              return
            },
          }),
        )
        .use(provideRequestScope)
        .get(
          "/global/health",
          describeRoute({
            summary: "Get health",
            description: "Get health information about the Synergy server.",
            operationId: "global.health",
            responses: {
              200: {
                description: "Health information",
                content: {
                  "application/json": {
                    schema: resolver(
                      z.object({
                        healthy: z.literal(true),
                        version: z.string(),
                        modelReady: z.boolean().meta({
                          description: "Whether at least one AI provider with a usable model is configured",
                        }),
                      }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            const providers = await Provider.list().catch((error) => {
              log.warn("failed to load providers for global health", {
                error: error instanceof Error ? error : new Error(String(error)),
              })
              return {}
            })
            const modelReady = Object.keys(providers).length > 0
            return c.json({ healthy: true, version: Installation.VERSION, modelReady })
          },
        )
        .get(
          "/global/event/ws",
          upgradeWebSocket(() => {
            let cleanup: (() => void) | undefined
            return {
              onOpen(_event, ws) {
                log.info("global event ws connected")
                ws.send(
                  JSON.stringify({
                    payload: {
                      type: "server.connected",
                      properties: {},
                    },
                  }),
                )
                const handler = (event: any) => {
                  try {
                    ws.send(JSON.stringify(event))
                  } catch {}
                }
                GlobalBus.on("event", handler)
                const heartbeat = setInterval(() => {
                  try {
                    ws.send(
                      JSON.stringify({
                        payload: {
                          type: "server.heartbeat",
                          properties: {},
                        },
                      }),
                    )
                  } catch {}
                }, 30000)
                cleanup = () => {
                  GlobalBus.off("event", handler)
                  clearInterval(heartbeat)
                }
              },
              onClose() {
                cleanup?.()
                log.info("global event ws disconnected")
              },
              onError() {
                cleanup?.()
              },
            }
          }),
        )
        .post(
          "/global/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose all Synergy instances, releasing all resources.",
            operationId: "global.dispose",
            responses: {
              200: {
                description: "Global disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.disposeAll()
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: Event.Disposed.type,
                properties: {},
              },
            })
            return c.json(true)
          },
        )
        .route("/holos", HolosRoute)
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
            } catch (err: any) {
              return c.json({ message: err?.message ?? String(err) }, 400)
            }
          },
        )
        .post(
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
        )
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "synergy",
                version: "0.0.3",
                description: "synergy api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .use(validator("query", z.object({ directory: z.string().optional() })))

        .route("/scope", ScopeRoute)
        .route("/git", GitRoute)
        .route("/pty", PtyRoute)
        .route("/config", ConfigRoute)
        .route("/runtime", RuntimeRoute)

        .get(
          "/experimental/tool/ids",
          describeRoute({
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
            operationId: "tool.ids",
            responses: {
              200: {
                description: "Tool IDs",
                content: {
                  "application/json": {
                    schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
                  },
                },
              },
              ...errors(400),
            },
          }),
          async (c) => {
            return c.json(await ToolRegistry.ids())
          },
        )
        .get(
          "/experimental/tool",
          describeRoute({
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
            operationId: "tool.list",
            responses: {
              200: {
                description: "Tools",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .array(
                          z
                            .object({
                              id: z.string(),
                              description: z.string(),
                              parameters: z.any(),
                            })
                            .meta({ ref: "ToolListItem" }),
                        )
                        .meta({ ref: "ToolList" }),
                    ),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "query",
            z.object({
              provider: z.string(),
              model: z.string(),
            }),
          ),
          async (c) => {
            const { provider } = c.req.valid("query")
            const tools = await ToolRegistry.tools(provider)
            return c.json(
              tools.map((t) => ({
                id: t.id,
                description: t.description,
                // Handle both Zod schemas and plain JSON schemas
                parameters: (t.parameters as any)?._def ? zodToJsonSchema(t.parameters as any) : t.parameters,
              })),
            )
          },
        )
        .post(
          "/instance/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose the current Synergy instance, releasing all resources.",
            operationId: "instance.dispose",
            responses: {
              200: {
                description: "Instance disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.dispose()
            return c.json(true)
          },
        )
        .get(
          "/path",
          describeRoute({
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the Synergy instance.",
            operationId: "path.get",
            responses: {
              200: {
                description: "Path",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          home: z.string(),
                          state: z.string(),
                          config: z.string(),
                          worktree: z.string(),
                          directory: z.string(),
                        })
                        .meta({
                          ref: "Path",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              home: Global.Path.home,
              state: Global.Path.state,
              config: Global.Path.config,
              worktree: Instance.worktree,
              directory: Instance.directory,
            })
          },
        )
        .post(
          "/experimental/worktree",
          describeRoute({
            summary: "Create worktree",
            description: "Create a new git worktree for the current project.",
            operationId: "worktree.create",
            responses: {
              200: {
                description: "Worktree created",
                content: {
                  "application/json": {
                    schema: resolver(Worktree.Info),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator("json", Worktree.create.schema),
          async (c) => {
            const body = c.req.valid("json")
            const worktree = await Worktree.create(body)
            return c.json(worktree)
          },
        )
        .get(
          "/experimental/worktree",
          describeRoute({
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
            operationId: "worktree.list",
            responses: {
              200: {
                description: "List of worktree directories",
                content: {
                  "application/json": {
                    schema: resolver(z.array(z.string())),
                  },
                },
              },
            },
          }),
          async (c) => {
            const sandboxes = await Scope.sandboxes(Instance.scope.id)
            return c.json(sandboxes)
          },
        )
        .get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
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
        )

        .route("/session", SessionRoute)
        .route("", PermissionRoute)
        .route("/question", QuestionRoute)
        .route("/session", SessionExportRoute)
        .route("/cortex/tasks", CortexRoute)

        .get(
          "/command",
          describeRoute({
            summary: "List commands",
            description: "Get a list of all available commands in the Synergy system.",
            operationId: "command.list",
            responses: {
              200: {
                description: "List of commands",
                content: {
                  "application/json": {
                    schema: resolver(Command.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const commands = await Command.list()
            return c.json(commands)
          },
        )

        .route("/provider", ProviderRoute)
        .route("/skill", SkillRoute)
        .route("/find", FindRoute)
        .route("/file", FileRoute)
        .route("/engram", EngramRoute)
        .route("/agenda", AgendaRoute)
        .route("/note", NoteRoute)
        .route("/asset", AssetRoute)
        .route("/holos", HolosDataRoute)

        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              service: z.string().max(64).meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().max(4096).meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            const safeExtra = extra ? Object.fromEntries(Object.entries(extra).slice(0, 20)) : undefined
            const logger = Log.create({ service: `client.${service}` })

            switch (level) {
              case "debug":
                logger.debug(message, safeExtra)
                break
              case "info":
                logger.info(message, safeExtra)
                break
              case "error":
                logger.error(message, safeExtra)
                break
              case "warn":
                logger.warn(message, safeExtra)
                break
            }

            return c.json(true)
          },
        )
        .get(
          "/agent",
          describeRoute({
            summary: "List agents",
            description: "Get a list of all available AI agents in the Synergy system.",
            operationId: "app.agents",
            responses: {
              200: {
                description: "List of agents",
                content: {
                  "application/json": {
                    schema: resolver(Agent.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const modes = await Agent.list()
            return c.json(modes)
          },
        )

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
        )

        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          validator("json", Auth.Info),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            return c.json(true)
          },
        )
        .get(
          "/event",
          describeRoute({
            summary: "Subscribe to events",
            description: "Get events",
            operationId: "event.subscribe",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(BusEvent.payloads()),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("event connected")
            c.header("X-Accel-Buffering", "no")
            c.header("Cache-Control", "no-cache, no-transform")
            return streamSSE(c, async (stream) => {
              stream.writeSSE({
                data: JSON.stringify({
                  type: "server.connected",
                  properties: {},
                }),
              })
              const unsub = Bus.subscribeAll(async (event) => {
                await stream.writeSSE({
                  data: JSON.stringify(event),
                })
                if (event.type === Bus.InstanceDisposed.type) {
                  stream.close()
                }
              })

              // Send heartbeat every 30s to prevent WKWebView timeout (60s default)
              const heartbeat = setInterval(() => {
                stream.writeSSE({
                  data: JSON.stringify({
                    type: "server.heartbeat",
                    properties: {},
                  }),
                })
              }, 30000)

              await new Promise<void>((resolve) => {
                stream.onAbort(() => {
                  clearInterval(heartbeat)
                  unsub()
                  resolve()
                  log.info("event disconnected")
                })
              })
            })
          },
        ) as unknown as Hono,
  )

  export function mountApp() {
    if (_appMounted) return
    // Ensure API routes are registered before SPA fallback routes.
    App()

    app
      .use("/*", async (c, next) => {
        const reqPath = decodeURI(new URL(c.req.url).pathname)

        const serveFile = (resolved: string, immutable?: boolean) => {
          const file = Bun.file(resolved)
          if (immutable) c.header("Cache-Control", "public, immutable, max-age=31536000")
          return c.body(file.stream(), { headers: { "Content-Type": file.type || "application/octet-stream" } })
        }

        const tryServe = async (candidate: string) => {
          if (!candidate.startsWith(APP_DIST)) return false
          const file = Bun.file(candidate)
          if (!(await file.exists().catch(() => false))) return false
          const stat = await file.stat()
          return !stat.isDirectory()
        }

        const exact = path.join(APP_DIST, reqPath)
        if (await tryServe(exact)) return serveFile(exact, exact.includes("/assets/"))

        // With base:"./", SPA deep-route refreshes cause the browser to resolve
        // relative asset paths against the current URL (e.g. /scope/session/assets/x.js
        // instead of /assets/x.js). Normalize by extracting the /assets/... suffix.
        const assetsIdx = reqPath.lastIndexOf("/assets/")
        if (assetsIdx > 0) {
          const normalized = path.join(APP_DIST, reqPath.slice(assetsIdx))
          if (await tryServe(normalized)) return serveFile(normalized, true)
        }

        // Root-level static files (favicon, webmanifest, etc.) also shift under
        // deep routes. Fall back to matching by basename in APP_DIST root.
        const basename = reqPath.split("/").pop()
        if (basename && basename.includes(".")) {
          const rootCandidate = path.join(APP_DIST, basename)
          if (rootCandidate !== exact && (await tryServe(rootCandidate))) return serveFile(rootCandidate)
        }

        return next()
      })
      .get("/*", async (c) => {
        const file = Bun.file(path.join(APP_DIST, "index.html"))
        if (await file.exists().catch(() => false)) {
          const html = await file.text()
          const reqPath = new URL(c.req.url).pathname
          const routeTag = `<script>window.__SYNERGY_ROUTE__=${JSON.stringify(reqPath)}</script>`
          const rendered = html.includes("</head>") ? html.replace("</head>", `${routeTag}\n</head>`) : routeTag + html
          return c.body(rendered, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }
        return c.notFound()
      })
    _appMounted = true
  }

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "synergy",
          version: "1.0.0",
          description: "synergy api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  function lanOrigins(): string[] {
    const { networkInterfaces } = require("os") as typeof import("os")
    const nets = networkInterfaces()
    const ips: string[] = []
    for (const interfaces of Object.values(nets)) {
      if (!interfaces) continue
      for (const iface of interfaces) {
        if (!iface.internal && iface.family === "IPv4") {
          ips.push(iface.address)
        }
      }
    }
    const ports = [3000, 3001]
    return ips.flatMap((ip) => ports.map((port) => `http://${ip}:${port}`))
  }

  export function listen(opts: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    const isExternalHost = opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    _corsWhitelist = [...(opts.cors ?? []), ...(isExternalHost ? lanOrigins() : [])]

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: App().fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(DEFAULT_PORT) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    if (isExternalHost && _corsWhitelist.length > 0) {
      log.info("cors auto-detected LAN origins", { origins: _corsWhitelist })
    }

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, `synergy-${server.port!}`)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      Agenda.stop()
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    Agenda.start()
      .then(() => AgendaBootstrap.seed())
      .catch((err) => {
        log.error("failed to start agenda", { error: err instanceof Error ? err : new Error(String(err)) })
      })

    return server
  }
}
