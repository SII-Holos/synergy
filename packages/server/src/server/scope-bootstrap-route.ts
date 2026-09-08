import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Command } from "@ericsanchezok/synergy-runtime-local/command/command"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { CortexTypes } from "@ericsanchezok/synergy-harness/cortex/types"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
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
    cortex: CortexTypes.Task.array().optional(),
    _errors: z.record(z.string(), BootstrapFieldError).optional(),
  })
  .meta({ ref: "ScopeBootstrapResponse" })

export type BootstrapContributions = Record<
  string,
  {
    schema: z.ZodType
    load: () => Promise<unknown>
    projectOnly?: boolean
  }
>

type SettledField = {
  field: string
  value?: unknown
  error?: { code: string; message: string }
}

function settle<T>(field: string, request: Promise<T>): Promise<SettledField> {
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

export function createScopeBootstrapRoute(contributions: BootstrapContributions = {}) {
  const responseSchema = ScopeBootstrapResponse.extend(
    Object.fromEntries(
      Object.entries(contributions).map(([name, contribution]) => [name, contribution.schema.optional()]),
    ),
  ).meta({ ref: "ScopeBootstrapResponse" })
  return new Hono().get(
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
              schema: resolver(responseSchema),
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
      const Cortex = import("@ericsanchezok/synergy-harness/cortex/manager").then((module) => module.Cortex)
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
        settle(
          "cortex",
          Cortex.then((manager) => manager.listVisible()),
        ),
        ...Object.entries(contributions).flatMap(([name, contribution]) =>
          contribution.projectOnly && scope.type !== "project" ? [] : [settle(name, contribution.load())],
        ),
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
}
