import { Agent } from "@/agent/agent"
import { AgendaStore, AgendaTypes } from "@/agenda"
import { Command } from "@/command/command"
import { Config } from "@/config/config"
import { CortexTypes } from "@/cortex/types"
import { Global } from "@/global"
import { LSP } from "@/lsp"
import { MCP } from "@/mcp"
import { Vcs } from "@/project/vcs"
import { ScopeContext } from "@/scope/context"
import { Session } from "@/session"
import { SessionManager } from "@/session/manager"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { listProvidersForClient, ProviderListResponse } from "./provider-view"

const BootstrapPath = z
  .object({
    home: z.string(),
    state: z.string(),
    config: z.string(),
    worktree: z.string(),
    directory: z.string(),
  })
  .meta({ ref: "ScopeBootstrapPath" })

const BootstrapSessions = z
  .object({
    data: Session.Info.array(),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  })
  .meta({ ref: "ScopeBootstrapSessions" })

const BootstrapFieldError = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .meta({ ref: "ScopeBootstrapFieldError" })

export const ScopeBootstrapResponse = z
  .object({
    scopeID: z.string(),
    provider: ProviderListResponse,
    agent: Agent.Info.array(),
    config: Config.Info,
    path: BootstrapPath.optional(),
    command: Command.Info.array().optional(),
    sessionStatus: z.record(z.string(), Session.StatusInfo).optional(),
    sessions: BootstrapSessions.optional(),
    mcp: z.record(z.string(), MCP.Status).optional(),
    cortex: CortexTypes.Task.array().optional(),
    agenda: AgendaTypes.Item.array().optional(),
    lsp: LSP.Status.array().optional(),
    vcs: Vcs.Info.optional(),
    _errors: z.record(z.string(), BootstrapFieldError).optional(),
  })
  .meta({ ref: "ScopeBootstrapResponse" })

type BootstrapField = Exclude<
  keyof z.infer<typeof ScopeBootstrapResponse>,
  "scopeID" | "provider" | "agent" | "config" | "_errors"
>

type SettledField = {
  field: BootstrapField
  value?: unknown
  error?: { code: string; message: string }
}

function settle<T>(field: BootstrapField, request: Promise<T>): Promise<SettledField> {
  return request.then(
    (value) => ({ field, value }),
    () => ({
      field,
      error: {
        code: "RESOURCE_FAILED",
        message: "Failed to load bootstrap field",
      },
    }),
  )
}

export const ScopeBootstrapRoute = new Hono().get(
  "/bootstrap",
  describeRoute({
    summary: "Get scope bootstrap snapshot",
    description: "Retrieve the initial state needed to render a scope in one request.",
    operationId: "scope.bootstrap",
    responses: {
      200: {
        description: "Scope bootstrap snapshot",
        content: {
          "application/json": {
            schema: resolver(ScopeBootstrapResponse),
          },
        },
      },
      ...errors(400, 404),
    },
  }),
  async (c) => {
    c.header("cache-control", "no-store")
    const scope = ScopeContext.current.scope
    const providerRequest = listProvidersForClient()
    const agentRequest = Agent.list()
    const configRequest = Config.current().then(Config.redactForClient)
    const sessionPageRequest = Session.list({ offset: 0, limit: 20, parentOnly: false }).then((result) => ({
      data: result.data,
      total: result.total,
      offset: 0,
      limit: 20,
    }))
    const Cortex = import("@/cortex/manager").then((module) => module.Cortex)
    const optionalRequests = [
      settle(
        "path",
        Promise.resolve({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: ScopeContext.current.worktree,
          directory: ScopeContext.current.directory,
        }),
      ),
      settle("command", Command.list()),
      settle("sessionStatus", SessionManager.listStatuses(scope.id)),
      settle("sessions", sessionPageRequest),
      settle("mcp", MCP.status()),
      settle(
        "cortex",
        Cortex.then((manager) => manager.listVisible()),
      ),
      settle("agenda", AgendaStore.listForScope(scope.id)),
      ...(scope.type === "project"
        ? [
            settle("lsp", LSP.status()),
            settle(
              "vcs",
              Vcs.branch().then((branch) => ({ branch: branch ?? "" })),
            ),
          ]
        : []),
    ]

    const [provider, agent, config, fields] = await Promise.all([
      providerRequest,
      agentRequest,
      configRequest,
      Promise.all(optionalRequests),
    ])
    const response: Record<string, unknown> = {
      scopeID: scope.id,
      provider,
      agent,
      config,
    }
    const fieldErrors: Record<string, { code: string; message: string }> = {}
    for (const field of fields) {
      if (field.error) {
        fieldErrors[field.field] = field.error
        continue
      }
      response[field.field] = field.value
    }
    if (Object.keys(fieldErrors).length > 0) response._errors = fieldErrors
    return c.json(response as z.infer<typeof ScopeBootstrapResponse>)
  },
)
