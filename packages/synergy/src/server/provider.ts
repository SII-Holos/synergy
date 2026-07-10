import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { mapValues } from "remeda"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { ModelsDev } from "../provider/models"
import { ProviderAuth } from "../provider/auth"
import { Log } from "../util/log"
import { errors } from "./error"
import { ProviderCatalog } from "@/provider/catalog"
import { RuntimeReload } from "@/runtime/reload"
import { ProviderUsage } from "@/provider/usage-service"
import { AccountUsage } from "@/provider/usage"
import { Auth } from "@/provider/api-key"
import { ProviderProfile } from "@/provider/profile"
import { GitHubProvider } from "@/provider/github"
import { ProviderAuthHealth } from "@/provider/auth-health"

const log = Log.create({ service: "provider" })

const ProviderRuntimeAvailability = z
  .object({
    providerID: z.string(),
    available: z.boolean(),
    reason: z
      .enum([
        "connected",
        "not_connected",
        "disabled",
        "no_models",
        "authentication_required",
        "exhausted",
        "fallback_unverified",
      ])
      .optional(),
    healthCheck: z.enum(["models", "none"]).optional(),
    modelCount: z.number(),
  })
  .meta({ ref: "ProviderRuntimeAvailability" })

export const ProviderRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List providers",
      description: "Get a list of all available AI providers, including both available and connected ones.",
      operationId: "provider.list",
      responses: {
        200: {
          description: "List of providers",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  all: ModelsDev.Provider.array(),
                  default: z.record(z.string(), z.string()),
                  connected: z.array(z.string()),
                  configProviders: z.array(z.string()),
                  catalogProviders: z.array(z.string()),
                  profiles: z.record(z.string(), ProviderProfile.Metadata),
                  authHealth: z.record(z.string(), ProviderAuthHealth.Info),
                  runtimeAvailability: z.record(z.string(), ProviderRuntimeAvailability),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      using _ = log.time("providers")
      const config = await Config.current()
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

      const allProviders = await ProviderCatalog.resolve({ config, includeLive: false })
      const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
      for (const [key, value] of Object.entries(allProviders)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
          filteredProviders[key] = value
        }
      }

      const connected = await Provider.list()
      // Get custom provider IDs: providers that are loaded from config but NOT in models.dev
      // (i.e., user-created providers, not standard providers with custom options)
      const configProviders = Object.entries(connected)
        .filter(([id, provider]) => provider.source === "config" && !allProviders[id])
        .map(([id]) => id)
      const providers = Object.assign(
        mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
        connected,
      )
      const profiles = Object.fromEntries(
        Object.entries(providers).map(([providerID, provider]) => [
          providerID,
          ProviderCatalog.providerMetadata(filteredProviders[providerID] ?? provider),
        ]),
      )
      const entries = await Auth.entries()
      const healthProviderIDs = new Set([
        ...Object.keys(providers),
        ...Object.keys(entries),
        GitHubProvider.PROVIDER_ID,
      ])
      const authHealthByProvider = Object.fromEntries(
        [...healthProviderIDs].map((providerID) => {
          const health = ProviderAuthHealth.fromEntry(providerID, entries[providerID])
          if (health.status !== "not_configured") return [providerID, health]
          const provider = providers[providerID]
          const profile = ProviderProfile.get(providerID)
          const githubEnvironment =
            providerID === GitHubProvider.PROVIDER_ID &&
            !!(process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim())
          const runtimeConnected = Object.prototype.hasOwnProperty.call(connected, providerID)
          if (!runtimeConnected && !githubEnvironment) return [providerID, health]
          const environment = provider?.env?.some((name) => !!process.env[name]?.trim()) || githubEnvironment
          return [
            providerID,
            {
              providerID,
              status: "connected" as const,
              authKind: profile?.authKind,
              source: environment ? "env" : profile?.origin === "plugin" ? "plugin" : undefined,
            },
          ]
        }),
      )
      const runtimeAvailability = mapValues(providers, (provider) => {
        const disabledProvider = disabled.has(provider.id)
        const modelCount = Object.keys(provider.models).length
        const health = authHealthByProvider[provider.id]
        const authenticationRequired = health?.status === "action_required"
        const credentialExhausted = health?.status === "exhausted"
        const available =
          !disabledProvider &&
          !authenticationRequired &&
          !credentialExhausted &&
          Object.prototype.hasOwnProperty.call(connected, provider.id) &&
          modelCount > 0
        const profile = ProviderProfile.get(provider.id)
        const fallbackUnverified = ProviderCatalog.liveDiscoveryStatus(provider.id) === "fallback"
        return {
          providerID: provider.id,
          available,
          reason: disabledProvider
            ? ("disabled" as const)
            : authenticationRequired
              ? ("authentication_required" as const)
              : credentialExhausted
                ? ("exhausted" as const)
                : modelCount === 0
                  ? ("no_models" as const)
                  : fallbackUnverified && available
                    ? ("fallback_unverified" as const)
                    : available
                      ? ("connected" as const)
                      : ("not_connected" as const),
          healthCheck: profile?.healthCheck ?? "models",
          modelCount,
        }
      })
      const defaultModels = Object.fromEntries(
        Object.entries(providers).flatMap(([providerID, provider]) => {
          const model = Provider.sort(Object.values(provider.models))[0]
          return model ? [[providerID, model.id]] : []
        }),
      )
      return c.json({
        all: Object.values(providers),
        default: defaultModels,
        connected: Object.keys(connected),
        configProviders,
        catalogProviders: Object.keys(filteredProviders),
        profiles,
        authHealth: authHealthByProvider,
        runtimeAvailability,
      })
    },
  )
  .get(
    "/usage",
    describeRoute({
      summary: "List provider account usage",
      description: "Retrieve account usage snapshots for connected providers that expose usage information.",
      operationId: "provider.usage.list",
      responses: {
        200: {
          description: "Provider account usage snapshots",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), AccountUsage.Snapshot)),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await ProviderUsage.all())
    },
  )
  .get(
    "/:providerID/usage",
    describeRoute({
      summary: "Get provider account usage",
      description: "Retrieve account usage and quota windows for a provider.",
      operationId: "provider.usage.get",
      responses: {
        200: {
          description: "Provider account usage snapshot",
          content: {
            "application/json": {
              schema: resolver(AccountUsage.Snapshot),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "param",
      z.object({
        providerID: z.string().meta({ description: "Provider ID" }),
      }),
    ),
    async (c) => {
      const providerID = c.req.valid("param").providerID
      return c.json(await ProviderUsage.get(providerID))
    },
  )
  .get(
    "/auth",
    describeRoute({
      summary: "Get provider auth methods",
      description: "Retrieve available authentication methods for all AI providers.",
      operationId: "provider.auth",
      responses: {
        200: {
          description: "Provider auth methods",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await ProviderAuth.methods())
    },
  )
  .get(
    "/auth/github/status",
    describeRoute({
      summary: "Get GitHub auth status",
      description: "Get the managed GitHub account status used for GitHub CLI-backed actions.",
      operationId: "provider.auth.githubStatus",
      responses: {
        200: {
          description: "GitHub auth status",
          content: {
            "application/json": {
              schema: resolver(GitHubProvider.Status),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await GitHubProvider.status())
    },
  )
  .delete(
    "/auth/github",
    describeRoute({
      summary: "Remove GitHub auth credentials",
      description: "Remove the managed GitHub credential used for GitHub CLI-backed actions.",
      operationId: "provider.auth.githubLogout",
      responses: {
        200: {
          description: "GitHub credentials removed",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      await GitHubProvider.remove()
      await RuntimeReload.reload({ targets: ["provider"], reason: "GitHub credentials removed" })
      return c.json(true)
    },
  )
  .post(
    "/:providerID/oauth/authorize",
    describeRoute({
      summary: "OAuth authorize",
      description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
      operationId: "provider.oauth.authorize",
      responses: {
        200: {
          description: "Authorization URL and method",
          content: {
            "application/json": {
              schema: resolver(ProviderAuth.Authorization.optional()),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "param",
      z.object({
        providerID: z.string().meta({ description: "Provider ID" }),
      }),
    ),
    validator(
      "json",
      z.object({
        method: z.number().meta({ description: "Auth method index" }),
      }),
    ),
    async (c) => {
      const providerID = c.req.valid("param").providerID
      const { method } = c.req.valid("json")
      const result = await ProviderAuth.authorize({
        providerID,
        method,
      })
      return c.json(result)
    },
  )
  .post(
    "/:providerID/oauth/callback",
    describeRoute({
      summary: "OAuth callback",
      description: "Handle the OAuth callback from a provider after user authorization.",
      operationId: "provider.oauth.callback",
      responses: {
        200: {
          description: "OAuth callback processed successfully",
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
        providerID: z.string().meta({ description: "Provider ID" }),
      }),
    ),
    validator(
      "json",
      z.object({
        method: z.number().meta({ description: "Auth method index" }),
        code: z.string().optional().meta({ description: "OAuth authorization code" }),
      }),
    ),
    async (c) => {
      const providerID = c.req.valid("param").providerID
      const { method, code } = c.req.valid("json")
      await ProviderAuth.callback({
        providerID,
        method,
        code,
      })
      return c.json(true)
    },
  )
  .post(
    "/:providerID/import",
    describeRoute({
      summary: "Import provider credentials",
      description: "Import credentials from a local provider-specific credential source.",
      operationId: "provider.credentials.importCredentials",
      responses: {
        200: {
          description: "Credentials imported successfully",
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
        providerID: z.string().meta({ description: "Provider ID" }),
      }),
    ),
    validator(
      "json",
      z.object({
        method: z.number().meta({ description: "Auth method index" }),
      }),
    ),
    async (c) => {
      const providerID = c.req.valid("param").providerID
      const { method } = c.req.valid("json")
      await ProviderAuth.importCredentials({
        providerID,
        method,
      })
      return c.json(true)
    },
  )
