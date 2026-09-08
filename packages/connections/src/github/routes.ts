import { GithubIdentity } from "./identity"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { errors } from "@ericsanchezok/synergy-server/server/error"

export const GithubIdentityRoute = new Hono()
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
