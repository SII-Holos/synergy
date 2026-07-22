import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { ProviderAuth } from "../provider/auth"
import { Log } from "../util/log"
import { errors } from "./error"
import { RuntimeReload } from "@/runtime/reload"
import { ProviderUsage } from "@/provider/usage-service"
import { AccountUsage } from "@/provider/usage"
import { GitHubProvider } from "@/provider/github"
import { listProvidersForClient, ProviderListResponse } from "./provider-view"
import { ProviderCatalog } from "@/provider/catalog"

const log = Log.create({ service: "provider" })

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
              schema: resolver(ProviderListResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      using _ = log.time("providers")
      return c.json(await listProvidersForClient())
    },
  )
  .post(
    "/:providerID/models/refresh",
    describeRoute({
      summary: "Refresh provider models",
      description:
        "Refresh the account-visible model catalog for a provider without discarding the last verified list.",
      operationId: "provider.models.refresh",
      responses: {
        200: {
          description: "Provider model catalog state",
          content: {
            "application/json": {
              schema: resolver(ProviderCatalog.ModelCatalogState),
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
      const state = await ProviderCatalog.refresh(c.req.valid("param").providerID)
      await RuntimeReload.reload({ targets: ["provider"], reason: "provider model catalog refreshed" })
      return c.json(state)
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
