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
import { ProviderUsage } from "@/provider/usage-service"
import { AccountUsage } from "@/provider/usage"
import { Auth } from "@/provider/api-key"
import { ProviderProfile } from "@/provider/profile"

const log = Log.create({ service: "provider" })

const ProviderAuthHealth = z
  .object({
    providerID: z.string(),
    status: z.enum(["connected", "not_configured", "expired", "exhausted", "dead"]),
    authKind: z.string().optional(),
    source: z.string().optional(),
    updatedAt: z.number().optional(),
    reloginRequired: z.boolean().optional(),
    cooldownUntil: z.number().optional(),
    resetAt: z.number().optional(),
    failureCode: z.string().optional(),
  })
  .meta({ ref: "ProviderAuthHealth" })

const ProviderRuntimeAvailability = z
  .object({
    providerID: z.string(),
    available: z.boolean(),
    reason: z.enum(["connected", "not_connected", "disabled", "no_models"]).optional(),
    healthCheck: z.enum(["models", "none"]).optional(),
    modelCount: z.number(),
  })
  .meta({ ref: "ProviderRuntimeAvailability" })

async function authHealth(
  providerID: string,
  entry: Auth.StoreEntry | undefined,
): Promise<z.infer<typeof ProviderAuthHealth>> {
  if (!entry) {
    return {
      providerID,
      status: "not_configured",
      reloginRequired: false,
    }
  }
  const now = Date.now()
  const selected = await Auth.select(providerID)
  if (selected) {
    const info = selected.auth
    if (info.type === "oauth" && info.expires * 1000 <= now) {
      return {
        providerID,
        status: "expired",
        authKind: selected.poolEntry?.authKind ?? entry.authKind,
        source: selected.poolEntry?.source ?? entry.source,
        updatedAt: selected.poolEntry?.updatedAt ?? entry.updatedAt,
        reloginRequired: false,
      }
    }
    return {
      providerID,
      status: "connected",
      authKind: selected.poolEntry?.authKind ?? entry.authKind,
      source: selected.poolEntry?.source ?? entry.source,
      updatedAt: selected.poolEntry?.updatedAt ?? entry.updatedAt,
      reloginRequired: false,
    }
  }

  const pool = entry.pool ?? []
  const dead = pool.find((item) => item.status === "dead")
  const exhausted = pool.find((item) => item.status === "exhausted")
  if (dead && pool.every((item) => item.status === "dead")) {
    return {
      providerID,
      status: "dead",
      authKind: entry.authKind,
      source: entry.source,
      updatedAt: entry.updatedAt,
      reloginRequired: true,
      failureCode: dead.failureCode,
    }
  }
  if (exhausted) {
    return {
      providerID,
      status: "exhausted",
      authKind: entry.authKind,
      source: entry.source,
      updatedAt: entry.updatedAt,
      reloginRequired: false,
      cooldownUntil: exhausted.cooldownUntil,
      resetAt: exhausted.resetAt,
      failureCode: exhausted.failureCode,
    }
  }
  const info = Auth.infoFromEntry(entry)
  if (info?.type === "oauth" && info.expires * 1000 <= now) {
    return {
      providerID,
      status: "expired",
      authKind: entry.authKind,
      source: entry.source,
      updatedAt: entry.updatedAt,
      reloginRequired: false,
    }
  }
  return {
    providerID,
    status: "connected",
    authKind: entry.authKind,
    source: entry.source,
    updatedAt: entry.updatedAt,
    reloginRequired: false,
  }
}

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
                  authHealth: z.record(z.string(), ProviderAuthHealth),
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
      const authHealthByProvider = Object.fromEntries(
        await Promise.all(
          Object.values(providers).map(async (provider) => [
            provider.id,
            await authHealth(provider.id, entries[provider.id]),
          ]),
        ),
      )
      const runtimeAvailability = mapValues(providers, (provider) => {
        const disabledProvider = disabled.has(provider.id)
        const modelCount = Object.keys(provider.models).length
        const available =
          !disabledProvider && Object.prototype.hasOwnProperty.call(connected, provider.id) && modelCount > 0
        const profile = ProviderProfile.get(provider.id)
        return {
          providerID: provider.id,
          available,
          reason: disabledProvider
            ? ("disabled" as const)
            : modelCount === 0
              ? ("no_models" as const)
              : available
                ? ("connected" as const)
                : ("not_connected" as const),
          healthCheck: profile?.healthCheck ?? "models",
          modelCount,
        }
      })
      return c.json({
        all: Object.values(providers),
        default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
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
