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
import { GithubIdentity } from "@/provider/github-identity"
import { listProvidersForClient, ProviderListResponse } from "./provider-view"
import { ProviderCatalog } from "@/provider/catalog"
import { ProviderConnection } from "@/provider/connection"
import { Config } from "@/config/config"

const log = Log.create({ service: "provider" })

const ProviderAuthRemoveResponse = z
  .object({
    providerID: z.string(),
    cleared: z.literal(true),
  })
  .meta({ ref: "ProviderAuthRemoveResponse" })

const ProviderAuthDisconnectConflict = ProviderAuth.DisconnectUnavailable.Schema

async function reloadProviderConnections(change: Config.Change, reason: string) {
  await RuntimeReload.reload(
    {
      targets: ["provider"],
      scope: "global",
      reason,
    },
    { configChange: change },
  )
}

function providerConnectionError(error: unknown) {
  if (error instanceof ProviderConnection.ProfileNotFound) return error.toObject()
  if (error instanceof ProviderConnection.CatalogNotFound) return error.toObject()
  if (error instanceof ProviderConnection.AlreadyExists) return error.toObject()
  if (error instanceof ProviderConnection.NotFound) return error.toObject()
  if (error instanceof ProviderConnection.NotManaged) return error.toObject()
  if (error instanceof ProviderConnection.InUse) return error.toObject()
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
    "/connections",
    describeRoute({
      summary: "Create provider account connection",
      description:
        "Create a named account connection that reuses a canonical provider profile and model catalog. Credentials are connected separately.",
      operationId: "provider.connection.create",
      responses: {
        200: {
          description: "Provider account connection created",
          content: {
            "application/json": {
              schema: resolver(ProviderConnection.Info),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", ProviderConnection.CreateInput),
    async (c) => {
      try {
        const { connection, change } = await ProviderConnection.create(c.req.valid("json"))
        await reloadProviderConnections(change, `provider connection created: ${connection.id}`)
        return c.json(connection)
      } catch (error) {
        const failure = providerConnectionError(error)
        if (failure) return c.json(failure, 400)
        throw error
      }
    },
  )
  .patch(
    "/connections/:providerID",
    describeRoute({
      summary: "Update provider account connection",
      description: "Update the name, endpoint, or enabled state of a managed provider account connection.",
      operationId: "provider.connection.update",
      responses: {
        200: {
          description: "Provider account connection updated",
          content: {
            "application/json": {
              schema: resolver(ProviderConnection.Info),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ providerID: z.string().min(1) })),
    validator("json", ProviderConnection.UpdateInput),
    async (c) => {
      const { providerID } = c.req.valid("param")
      try {
        const { connection, change } = await ProviderConnection.update(providerID, c.req.valid("json"))
        await reloadProviderConnections(change, `provider connection updated: ${providerID}`)
        return c.json(connection)
      } catch (error) {
        const failure = providerConnectionError(error)
        if (failure) return c.json(failure, 400)
        throw error
      }
    },
  )
  .delete(
    "/connections/:providerID",
    describeRoute({
      summary: "Remove provider account connection",
      description:
        "Remove a managed provider account connection and its Synergy-managed credentials without changing its canonical provider profile or sibling accounts.",
      operationId: "provider.connection.remove",
      responses: {
        200: {
          description: "Provider account connection removed",
          content: {
            "application/json": {
              schema: resolver(ProviderConnection.Removed),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ providerID: z.string().min(1) })),
    async (c) => {
      const { providerID } = c.req.valid("param")
      try {
        const { result, change } = await ProviderConnection.remove(providerID)
        await reloadProviderConnections(change, `provider connection removed: ${providerID}`)
        return c.json(result)
      } catch (error) {
        const failure = providerConnectionError(error)
        if (failure) return c.json(failure, 400)
        throw error
      }
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
  .delete(
    "/:providerID/auth",
    describeRoute({
      summary: "Remove stored provider credentials",
      description:
        "Clear Synergy-managed stored credentials for a provider while preserving its catalog and configuration. " +
        "Credentials sourced from the environment or plugins are unaffected.",
      operationId: "provider.disconnect",
      responses: {
        200: {
          description: "Stored provider credentials removed",
          content: {
            "application/json": {
              schema: resolver(ProviderAuthRemoveResponse),
            },
          },
        },
        409: {
          description: "Stored provider credentials cannot be disconnected in their current state",
          content: {
            "application/json": {
              schema: resolver(ProviderAuthDisconnectConflict),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "param",
      z.object({
        providerID: z.string().min(1).meta({ description: "Provider ID" }),
      }),
    ),
    async (c) => {
      const providerID = c.req.valid("param").providerID
      try {
        await ProviderAuth.disconnect({ providerID })
        return c.json({ providerID, cleared: true as const })
      } catch (error) {
        if (error instanceof ProviderAuth.DisconnectUnavailable) return c.json(error.toObject(), 409)
        throw error
      }
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
  .get(
    "/auth/github/identity",
    describeRoute({
      summary: "Get GitHub git identity sync state",
      description: "Inspect the git global identity and the GitHub-account-derived identity the sync would apply.",
      operationId: "provider.auth.githubIdentity",
      responses: {
        200: {
          description: "Git identity sync state",
          content: {
            "application/json": {
              schema: resolver(GithubIdentity.State),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await GithubIdentity.state())
    },
  )
  .post(
    "/auth/github/identity/sync",
    describeRoute({
      summary: "Sync git identity from GitHub",
      description: "Apply the GitHub-account-derived (or explicitly configured) identity to git config --global.",
      operationId: "provider.auth.githubIdentitySync",
      responses: {
        200: {
          description: "Sync result",
          content: {
            "application/json": {
              schema: resolver(GithubIdentity.SyncResult),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        return c.json(await GithubIdentity.sync())
      } catch (error) {
        if (error instanceof GithubIdentity.SyncError) return c.json(error.toObject(), 400)
        throw error
      }
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
        signal: c.req.raw.signal,
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
