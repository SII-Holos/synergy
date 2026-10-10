import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Command } from "@ericsanchezok/synergy-local-runtime/command/command"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { CortexTypes } from "@ericsanchezok/synergy-harness/cortex/types"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { ScopePath } from "./scope-path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { listProvidersForClient, ProviderListResponse } from "./provider-view"
import { ProviderDirectory } from "./provider-directory"

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
    path: ScopePath.Schema.optional(),
    workspaces: WorkspaceCatalog.Info.array().optional(),
    command: Command.Summary.array().optional(),
    sessionStatus: z.record(z.string(), Session.StatusInfo).optional(),
    sessions: BootstrapSessions.optional(),
    cortex: CortexTypes.Task.array().optional(),
    _errors: z.record(z.string(), BootstrapFieldError).optional(),
  })
  .meta({ ref: "ScopeBootstrapResponse" })

const preferenceKeys = [
  "model",
  "default_agent",
  "role_variant",
  "controlProfile",
  "attachment",
  "quick_switcher",
  "defaultSessionWorkspace",
  "defaultSessionEnvironmentProfile",
  "activityDisplay",
  "compactReasoning",
  "welcomeGames",
  "locale",
  "fullAccessAcknowledged",
  "boss",
  "voice",
] as const
export const ScopeUIPreferences = z
  .lazy(() => {
    const fields = Config.Info.shape
    const keys = Object.fromEntries(preferenceKeys.filter((key) => key in fields).map((key) => [key, true])) as {
      [Key in Extract<(typeof preferenceKeys)[number], keyof typeof fields>]?: true
    }
    return Config.Info.pick(keys)
      .strip()
      .extend({
        voice: z.object({ stt: z.object({ model: z.string().optional() }).optional() }).optional(),
        boss: z.object({ enabled: z.boolean().optional() }).optional(),
      })
  })
  .meta({ ref: "ScopeUIPreferences" })
export const AgentSummary = Agent.Info.omit({
  prompt: true,
  options: true,
  permission: true,
  deferredTools: true,
}).meta({ ref: "AgentSummary" })
export const ScopeBootstrapCore = z
  .object({
    scopeID: z.string(),
    provider: ProviderDirectory.Selection,
    agent: AgentSummary.array(),
    config: ScopeUIPreferences,
    path: ScopePath.Schema,
    sessions: BootstrapSessions,
    sessionStatus: z.record(z.string(), Session.StatusInfo).meta({
      description: "Non-idle status for sessions included in the navigation page",
    }),
    workspaces: WorkspaceCatalog.Info.array(),
    workspacesComplete: z.literal(false),
  })
  .meta({ ref: "ScopeBootstrapCore" })

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
  return new Hono()
    .get(
      "/bootstrap-core",
      describeRoute({
        summary: "Get the essential Scope navigation and composer snapshot",
        operationId: "scope.bootstrapCore",
        responses: {
          200: {
            description: "Essential Scope state; model catalog and auxiliary panels load separately",
            content: { "application/json": { schema: resolver(ScopeBootstrapCore) } },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        c.header("cache-control", "no-store")
        const started = performance.now()
        const timings: string[] = []
        const measure = async <T>(name: string, operation: () => Promise<T>) => {
          const start = performance.now()
          try {
            return await operation()
          } finally {
            timings.push(`${name};dur=${(performance.now() - start).toFixed(1)}`)
          }
        }
        const scope = ScopeContext.current.scope
        const [config, agents, sessions] = await Promise.all([
          measure("core_config", () => Config.current()),
          measure("core_agents", () => Agent.list()),
          measure("core_sessions", () => Session.list({ offset: 0, limit: 20, parentOnly: false })),
        ])
        const sessionStatus = await measure("core_status", () => SessionManager.statusesFor(sessions.data))
        const keys = agents.flatMap((agent) => (agent.model ? [agent.model] : []))
        for (const [field, value] of Object.entries(config)) {
          if ((field === "model" || field.endsWith("_model")) && typeof value === "string" && value.includes("/")) {
            const split = value.indexOf("/")
            keys.push({ providerID: value.slice(0, split), modelID: value.slice(split + 1) })
          }
        }
        for (const session of sessions.data)
          if (session.modelSelection?.selected?.model) keys.push(session.modelSelection.selected.model)
        const provider = await measure("core_provider", () => ProviderDirectory.selection(keys))
        const visible = new Set(sessions.data.flatMap((session) => (session.workspaceID ? [session.workspaceID] : [])))
        const path = ScopePath.current()
        if (path.workspace?.id) visible.add(path.workspace.id)
        const workspaces = await measure("core_workspaces", () => WorkspaceCatalog.readMany([...visible]))
        const response = ScopeBootstrapCore.parse({
          scopeID: scope.id,
          provider,
          agent: agents.map((agent) => AgentSummary.parse(agent)),
          config: ScopeUIPreferences.parse(Config.redactForClient(ScopeUIPreferences.parse(config))),
          path,
          sessions: { ...sessions, offset: 0, limit: 20 },
          sessionStatus,
          workspaces: workspaces.filter(
            (workspace): workspace is WorkspaceCatalog.Info => workspace?.scopeID === scope.id,
          ),
          workspacesComplete: false,
        })
        c.header("server-timing", [...timings, `core;dur=${(performance.now() - started).toFixed(1)}`].join(", "))
        return c.json(response)
      },
    )
    .get(
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
        const timings: string[] = []
        const timed = <T>(field: string, request: Promise<T>) => {
          const start = performance.now()
          return request.finally(() => {
            timings.push(`${field.replace(/[^a-zA-Z0-9_-]/g, "_")};dur=${(performance.now() - start).toFixed(1)}`)
          })
        }
        const optional = <T>(field: string, request: Promise<T>) => settle(field, timed(field, request))
        const providerRequest = timed("provider", listProvidersForClient())
        const agentRequest = timed("agent", Agent.list())
        const configRequest = timed("config", Config.current().then(Config.redactForClient))
        const sessionPageRequest = Session.list({ offset: 0, limit: 20, parentOnly: false }).then((result) => ({
          data: result.data,
          total: result.total,
          offset: 0,
          limit: 20,
        }))
        const Cortex = import("@ericsanchezok/synergy-harness/cortex/manager").then((module) => module.Cortex)
        const optionalRequests = [
          optional("path", Promise.resolve(ScopePath.current())),
          optional("command", Command.summaries()),
          optional("sessionStatus", SessionManager.listStatuses(scope.id)),
          optional("sessions", sessionPageRequest),
          optional(
            "workspaces",
            sessionPageRequest.then(() => WorkspaceCatalog.list(scope.id)),
          ),
          optional(
            "cortex",
            Cortex.then((manager) => manager.listVisible()),
          ),
          ...Object.entries(contributions).flatMap(([name, contribution]) =>
            contribution.projectOnly && !scope.local ? [] : [optional(name, contribution.load())],
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
        c.header("server-timing", timings.join(", "))
        return c.json(response as z.infer<typeof ScopeBootstrapResponse>)
      },
    )
}
