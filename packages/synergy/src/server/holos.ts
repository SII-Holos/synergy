import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Access } from "../access"
import { Contact } from "../holos/contact"
import { Mailbox } from "../holos/mailbox"
import { HolosAuth } from "../holos/auth"
import { HOLOS_URL } from "../holos/constants"
import { HolosLoginFlow } from "../holos/login-flow"
import { HolosProtocol } from "../holos/protocol"
import { HolosReadiness } from "../holos/readiness"
import { Presence } from "../holos/presence"
import { HolosRuntime } from "../holos/runtime"
import { HolosState } from "../holos/state"
import { HolosAccounts } from "../holos/accounts"
import { HolosProfile } from "../holos/profile"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { errors } from "./error"

const log = Log.create({ service: "server.holos" })

const pendingStates = new Map<
  string,
  { state: string; createdAt: number; callbackOrigin: string; profile: HolosProfile.Input }
>()

const STATE_TTL_MS = 5 * 60_000

function holosApiUrl(path: string): string {
  return new URL(path, HOLOS_URL).toString()
}

function cleanupExpiredStates() {
  const now = Date.now()
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(key)
  }
}

function resolveCallbackUrl(input: { requested?: string; serverOrigin: string }): string | undefined {
  const fallback = Access.fromServerUrl(input.serverOrigin).callbackUrl
  if (!input.requested) return fallback
  try {
    const requested = new URL(input.requested)
    if (requested.origin !== new URL(fallback).origin) return undefined
    if (requested.pathname !== "/holos/callback") return undefined
    return requested.toString()
  } catch {
    return undefined
  }
}

async function currentHolosApiUrl(): Promise<string | undefined> {
  const config = await Config.current().catch(() => undefined)
  return config?.holos?.apiUrl
}

const LoginResponse = z
  .object({
    url: z.string(),
  })
  .meta({ ref: "HolosLoginResponse" })

export const HolosRoute = new Hono()
  .post(
    "/login",
    describeRoute({
      summary: "Initiate Holos login",
      description: "Generate a Holos bind URL for browser-based login. Returns a URL to open in a popup.",
      operationId: "holos.login",
      responses: {
        200: {
          description: "Login URL",
          content: {
            "application/json": {
              schema: resolver(LoginResponse),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z.object({
        callbackUrl: z.string().url().optional(),
        profile: HolosProfile.Input,
      }),
    ),
    async (c) => {
      cleanupExpiredStates()
      const body = c.req.valid("json")
      const serverOrigin = new URL(c.req.url).origin
      const callbackUrl = resolveCallbackUrl({ requested: body?.callbackUrl, serverOrigin })
      if (!callbackUrl) return c.json({ message: "callbackUrl must point to this server's /holos/callback" }, 400)

      const state = crypto.randomUUID()
      pendingStates.set(state, {
        state,
        createdAt: Date.now(),
        callbackOrigin: new URL(callbackUrl).origin,
        profile: body.profile,
      })

      return c.json({ url: HolosLoginFlow.createBindUrl({ callbackUrl, state }) })
    },
  )
  .get(
    "/callback",
    describeRoute({
      summary: "Holos login callback",
      description: "Handles the redirect from Holos after user login. Exchanges the code for credentials.",
      operationId: "holos.callback",
      responses: {
        200: {
          description: "Login result HTML page",
          content: { "text/html": { schema: resolver(z.string()) } },
        },
      },
    }),
    async (c) => {
      const code = c.req.query("code")
      const state = c.req.query("state")

      const callbackOrigin = new URL(c.req.url).origin
      if (!code || !state) {
        return c.html(
          resultPage({
            title: "Could not connect agent",
            message: "The sign-in link was incomplete. Return to Synergy and try again.",
            success: false,
            targetOrigin: callbackOrigin,
            error: "Missing code or state parameter.",
          }),
        )
      }

      const pending = pendingStates.get(state)
      if (!pending) {
        return c.html(
          resultPage({
            title: "Could not connect agent",
            message: "This sign-in window expired. Start a new connection from Synergy.",
            success: false,
            targetOrigin: callbackOrigin,
            error: "Invalid or expired state.",
          }),
        )
      }
      pendingStates.delete(state)

      try {
        const { agentId, agentSecret } = await HolosLoginFlow.exchange({ code, state, profile: pending.profile })
        await HolosLoginFlow.saveAndReload({ agentId, agentSecret })
        return c.html(
          resultPage({
            title: "Agent connected",
            message: "Synergy has received your Holos agent and is getting your workspace ready.",
            success: true,
            targetOrigin: pending.callbackOrigin,
            agentId,
          }),
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.html(
          resultPage({
            title: "Could not connect agent",
            message: "Holos could not finish connecting this agent. Return to Synergy and try again.",
            success: false,
            targetOrigin: pending.callbackOrigin,
            error: message,
          }),
        )
      }
    },
  )
  .post(
    "/credentials",
    describeRoute({
      summary: "Set agent credentials",
      description:
        "Validate and save existing agent credentials by fetching the canonical Holos agent profile from the remote API.",
      operationId: "holos.credentials",
      responses: {
        200: {
          description: "Credentials saved",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    success: z.literal(true),
                    agentId: z.string(),
                    profile: HolosProfile.Info,
                  })
                  .meta({ ref: "HolosCredentialsResponse" }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        agentSecret: z.string().min(1),
        expectedAgentId: z.string().min(1).optional(),
      }),
    ),
    async (c) => {
      const { agentSecret, expectedAgentId } = c.req.valid("json")

      let me: HolosProfile.MeInfo
      try {
        me = await HolosProfile.getMe({ agentSecret, apiUrl: await currentHolosApiUrl() })
      } catch (err) {
        return c.json({ message: err instanceof Error ? err.message : String(err) }, 400)
      }

      if (expectedAgentId && me.agentId !== expectedAgentId) {
        return c.json({ message: `Agent secret belongs to ${me.agentId}, not ${expectedAgentId}` }, 400)
      }

      await HolosAuth.saveCredentialsAndConfigure(me.agentId, agentSecret)
      HolosAuth.reloadRuntime().catch((err: unknown) =>
        log.warn("holos runtime reload after credentials save failed", { error: err }),
      )

      return c.json({ success: true as const, agentId: me.agentId, profile: me.profile })
    },
  )
  .delete(
    "/credentials",
    describeRoute({
      summary: "Clear active Holos credentials",
      description: "Remove the active Holos account credentials and stop the Holos runtime. Used for sign-out.",
      operationId: "holos.logout",
      responses: {
        200: {
          description: "Credentials cleared",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) }).meta({ ref: "HolosLogoutResponse" })),
            },
          },
        },
      },
    }),
    async (c) => {
      await HolosRuntime.stop()
      await HolosAuth.clearActiveAccount()
      return c.json({ success: true as const })
    },
  )
  .post(
    "/reconnect",
    describeRoute({
      summary: "Reconnect Holos runtime",
      description: "Reload the Holos runtime connection. Useful when the WebSocket disconnects.",
      operationId: "holos.reconnect",
      responses: {
        200: {
          description: "Reconnect initiated",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) }).meta({ ref: "HolosReconnectResponse" })),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const credentials = await HolosAuth.getStoredCredential()
      if (!credentials) {
        return c.json({ message: "No Holos credentials found" }, 400)
      }

      try {
        await HolosAuth.reloadRuntime()
        return c.json({ success: true as const })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ message }, 400)
      }
    },
  )

export const HolosDataRoute = new Hono()

  // --- Credentials status (local scan) ---

  .get(
    "/credentials/status",
    describeRoute({
      summary: "Check local credential status",
      description:
        "Check whether local Holos credentials exist without verifying them against the remote API. Returns existence, agent ID, and a masked secret.",
      operationId: "holos.credentials.status",
      responses: {
        200: {
          description: "Credential status",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    exists: z.boolean(),
                    agentId: z.string().optional(),
                    maskedSecret: z.string().optional(),
                  })
                  .meta({ ref: "HolosCredentialsStatusResponse" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const stored = await HolosAuth.getStoredCredential()
      if (!stored) {
        return c.json({ exists: false })
      }
      return c.json({
        exists: true,
        agentId: stored.agentId,
        maskedSecret: stored.maskedSecret,
      })
    },
  )

  // --- Unified state ---

  .get(
    "/state",
    describeRoute({
      summary: "Get unified Holos state",
      description:
        "Return a unified Holos state surface combining identity, connection, capability, entitlement, profile, contact, request, and presence data.",
      operationId: "holos.state",
      responses: {
        200: {
          description: "Unified Holos state",
          content: {
            "application/json": {
              schema: resolver(HolosState.Info),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await HolosState.get())
    },
  )

  .get(
    "/profile",
    describeRoute({
      summary: "Get current Holos agent profile",
      description: "Fetch the active agent profile from Holos. Synergy does not cache profile data locally.",
      operationId: "holos.profile.get",
      responses: {
        200: {
          description: "Current Holos profile",
          content: {
            "application/json": {
              schema: resolver(HolosProfile.MeInfo),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const credential = await HolosAuth.getStoredCredential()
      if (!credential) return c.json({ message: "No Holos credentials found" }, 400)
      try {
        const profile = await HolosProfile.getCurrent({
          agentId: credential.agentId,
          agentSecret: credential.agentSecret,
          apiUrl: await currentHolosApiUrl(),
        })
        return c.json(profile)
      } catch (err) {
        return c.json({ message: err instanceof Error ? err.message : String(err) }, 400)
      }
    },
  )

  .put(
    "/profile",
    describeRoute({
      summary: "Update current Holos agent profile",
      description:
        "Merge editable profile fields into the active remote Holos profile while preserving unknown remote fields.",
      operationId: "holos.profile.update",
      responses: {
        200: {
          description: "Updated Holos profile",
          content: {
            "application/json": {
              schema: resolver(HolosProfile.MeInfo),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", HolosProfile.Input),
    async (c) => {
      const credential = await HolosAuth.getStoredCredential()
      if (!credential) return c.json({ message: "No Holos credentials found" }, 400)
      try {
        const profile = await HolosProfile.updateCurrent({
          agentId: credential.agentId,
          agentSecret: credential.agentSecret,
          profile: c.req.valid("json"),
          apiUrl: await currentHolosApiUrl(),
        })
        return c.json(profile)
      } catch (err) {
        return c.json({ message: err instanceof Error ? err.message : String(err) }, 400)
      }
    },
  )

  .get(
    "/verify",
    describeRoute({
      summary: "Verify Holos credentials",
      description:
        "Check whether the stored agent credentials are still valid by attempting to fetch a ws_token from Holos.",
      operationId: "holos.verify",
      responses: {
        200: {
          description: "Credentials valid",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    valid: z.literal(true),
                    agentId: z.string(),
                  })
                  .meta({ ref: "HolosVerifyResponse" }),
              ),
            },
          },
        },
        ...errors(401),
      },
    }),
    async (c) => {
      try {
        const result = await HolosAuth.verifyStoredCredentials()
        if (!result.valid) {
          return c.json({ message: result.reason }, 401)
        }
        return c.json({ valid: true as const, agentId: result.agentId })
      } catch {
        return c.json({ message: "Unable to reach Holos to verify credentials" }, 401)
      }
    },
  )
  // --- Multi-account management ---

  .get(
    "/accounts",
    describeRoute({
      summary: "List Holos accounts",
      description: "List all stored Holos accounts. Secrets are never included in the response.",
      operationId: "holos.accounts.list",
      responses: {
        200: {
          description: "Account list",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    activeAccountId: z.string().nullable(),
                    accounts: HolosState.AccountMeta.array(),
                  })
                  .meta({ ref: "HolosAccountsListResponse" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const accounts = await HolosAccounts.listAccounts()
      const active = await HolosAccounts.getActiveAccount()
      return c.json({
        activeAccountId: active?.agentId ?? null,
        accounts: accounts.map((a) => ({
          agentId: a.agentId,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
      })
    },
  )

  .post(
    "/accounts/switch",
    describeRoute({
      summary: "Switch active Holos account",
      description: "Switch the active Holos account and reload the runtime to connect with new credentials.",
      operationId: "holos.accounts.switch",
      responses: {
        200: {
          description: "Account switched",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    success: z.literal(true),
                    activeAccountId: z.string(),
                    status: HolosState.ConnectionStatus,
                  })
                  .meta({ ref: "HolosAccountsSwitchResponse" }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        agentId: z.string().min(1),
      }),
    ),
    async (c) => {
      const { agentId } = c.req.valid("json")
      const account = await HolosAccounts.getAccount(agentId)
      if (!account) {
        return c.json({ message: `Account not found: ${agentId}` }, 404)
      }

      await HolosAccounts.setActiveAccount(agentId)

      let status: HolosState.ConnectionStatus = "disconnected"
      try {
        await HolosAuth.configureHolos()
        await HolosAuth.reloadRuntime()
        const runtimeStatus = await HolosRuntime.status()
        status = runtimeStatus.status
      } catch (err) {
        log.warn("runtime reload after account switch failed", { error: err })
        status = "failed"
      }

      return c.json({ success: true as const, activeAccountId: agentId, status })
    },
  )

  .delete(
    "/accounts/:agentId",
    describeRoute({
      summary: "Remove a Holos account",
      description:
        "Remove a stored Holos account. If the account is active, stops the runtime and clears the active state.",
      operationId: "holos.accounts.remove",
      responses: {
        200: {
          description: "Account removed",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    success: z.literal(true),
                    activeAccountId: z.string().nullable(),
                    wasActive: z.boolean(),
                  })
                  .meta({ ref: "HolosAccountsRemoveResponse" }),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ agentId: z.string() })),
    async (c) => {
      const agentId = c.req.valid("param").agentId
      const account = await HolosAccounts.getAccount(agentId)
      if (!account) {
        return c.json({ message: `Account not found: ${agentId}` }, 404)
      }

      const active = await HolosAccounts.getActiveAccount()
      const wasActive = active?.agentId === agentId

      if (wasActive) {
        await HolosRuntime.stop()
      }

      await HolosAccounts.deleteAccount(agentId)

      const newActive = await HolosAccounts.getActiveAccount()

      return c.json({
        success: true as const,
        activeAccountId: newActive?.agentId ?? null,
        wasActive,
      })
    },
  )

  // --- Connection status ---

  .get(
    "/status",
    describeRoute({
      summary: "Get Holos connection status",
      description:
        "Return the current connection status for the active account. Non-active accounts show as disconnected.",
      operationId: "holos.status",
      responses: {
        200: {
          description: "Connection status",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    agentId: z.string().nullable(),
                    status: HolosState.ConnectionStatus,
                    error: z.string().optional(),
                    peerId: z.string().nullable(),
                  })
                  .meta({ ref: "HolosStatusResponse" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const active = await HolosAccounts.getActiveAccount()
      const runtimeStatus = await HolosRuntime.status()
      const provider = await HolosRuntime.getProvider()

      return c.json({
        agentId: active?.agentId ?? null,
        status: runtimeStatus.status,
        error: "error" in runtimeStatus ? runtimeStatus.error : undefined,
        peerId: provider?.peerId ?? null,
      })
    },
  )

  // --- Contacts ---

  .get(
    "/contact",
    describeRoute({
      summary: "List contacts",
      description: "List all contacts.",
      operationId: "holos.contact.list",
      responses: {
        200: {
          description: "List of contacts",
          content: { "application/json": { schema: resolver(Contact.Info.array()) } },
        },
      },
    }),
    async (c) => {
      const contacts = await Contact.list()
      return c.json(contacts)
    },
  )

  .get(
    "/contact/:id",
    describeRoute({
      summary: "Get contact",
      description: "Get a specific contact by ID.",
      operationId: "holos.contact.get",
      responses: {
        200: {
          description: "Contact",
          content: { "application/json": { schema: resolver(Contact.Info) } },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      const contact = await Contact.get(c.req.valid("param").id)
      if (!contact) return c.json({ message: "Contact not found" }, 404)
      return c.json(contact)
    },
  )

  .post(
    "/contact",
    describeRoute({
      summary: "Add contact",
      description: "Add a new contact.",
      operationId: "holos.contact.add",
      responses: {
        200: {
          description: "Added contact",
          content: { "application/json": { schema: resolver(Contact.Info) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const contact = await Contact.add({
        id: body.id,
        name: body.name,
        blocked: false,
        addedAt: Date.now(),
      })
      return c.json(contact)
    },
  )

  .delete(
    "/contact/:id",
    describeRoute({
      summary: "Remove contact",
      description: "Remove a contact.",
      operationId: "holos.contact.remove",
      responses: {
        200: {
          description: "Removed",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
      },
    }),
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      const id = c.req.valid("param").id
      const contact = await Contact.get(id)
      if (contact) {
        Presence.remove(contact.id)
      }
      await Contact.remove(id)
      return c.json(true)
    },
  )

  // --- Contact config ---

  .put(
    "/contact/:id/block",
    describeRoute({
      summary: "Toggle contact blocked status",
      description: "Block or unblock a contact. Blocked contacts' messages are silently discarded.",
      operationId: "holos.contact.toggleBlock",
      responses: {
        200: {
          description: "Updated contact",
          content: { "application/json": { schema: resolver(Contact.Info) } },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator("json", z.object({ blocked: z.boolean() })),
    async (c) => {
      const id = c.req.valid("param").id
      const { blocked } = c.req.valid("json")
      const existing = await Contact.get(id)
      if (!existing) return c.json({ message: "Contact not found" }, 404)
      const updated = await Contact.update({ ...existing, blocked })
      return c.json(updated)
    },
  )

  // --- Presence ---

  .get(
    "/presence",
    describeRoute({
      summary: "Get friend presence",
      description: "Get the online/offline status of all contacts from the presence cache.",
      operationId: "holos.presence",
      responses: {
        200: {
          description: "Presence map",
          content: {
            "application/json": {
              schema: resolver(z.record(z.string(), z.string()).meta({ ref: "HolosPresenceMap" })),
            },
          },
        },
      },
    }),
    async (c) => {
      const presenceMap = Presence.all()
      const result: Record<string, string> = {}
      for (const [id, status] of presenceMap) {
        result[id] = status
      }
      return c.json(result)
    },
  )

  // --- Agent discovery ---

  .get(
    "/agents",
    describeRoute({
      summary: "List agents",
      description: "List available agents from the Holos platform.",
      operationId: "holos.agents.list",
      responses: {
        200: {
          description: "Agent list",
          content: { "application/json": { schema: resolver(HolosProtocol.AgentListResponse) } },
        },
        ...errors(503),
      },
    }),
    validator(
      "query",
      z.object({
        limit: z.coerce.number().optional().default(20),
        offset: z.coerce.number().optional().default(0),
        need_active: z.coerce.boolean().optional().default(true),
      }),
    ),
    async (c) => {
      const holos = await HolosReadiness.snapshot()
      if (!holos.credential) {
        return c.json({ message: "Holos credentials not found" }, 503)
      }
      if (!holos.readiness.ready) {
        return c.json({ message: "Holos is not ready" }, 503)
      }

      const query = c.req.valid("query")
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
        need_active: String(query.need_active),
      })

      const res = await fetch(holosApiUrl(`/api/v1/holos/agent_tunnel/agents/list?${params}`), {
        headers: { Authorization: `Bearer ${holos.credential.agentSecret}` },
      })
      if (!res.ok) return c.json({ message: `Holos API error: ${res.status}` }, 503)

      const body = await res.json()
      return c.json(body)
    },
  )

  .get(
    "/agents/:agentId",
    describeRoute({
      summary: "Get agent",
      description: "Get a specific agent's profile from the Holos platform.",
      operationId: "holos.agents.get",
      responses: {
        200: {
          description: "Agent detail",
          content: { "application/json": { schema: resolver(HolosProtocol.AgentDetailResponse) } },
        },
        ...errors(404, 503),
      },
    }),
    validator("param", z.object({ agentId: z.string() })),
    async (c) => {
      const holos = await HolosReadiness.snapshot()
      if (!holos.credential) {
        return c.json({ message: "Holos credentials not found" }, 503)
      }
      if (!holos.readiness.ready) {
        return c.json({ message: "Holos is not ready" }, 503)
      }

      const agentId = c.req.valid("param").agentId
      const res = await fetch(holosApiUrl(`/api/v1/holos/agent_tunnel/agents/${agentId}`), {
        headers: { Authorization: `Bearer ${holos.credential.agentSecret}` },
      })
      if (!res.ok) return c.json({ message: `Agent not found: ${res.status}` }, 404)

      const body = await res.json()
      return c.json(body)
    },
  )

  // --- Mailbox ---

  .post(
    "/send",
    describeRoute({
      summary: "Send message to Holos contact",
      description:
        "Send a text message to a Holos agent by ID. Messages are sent via WebSocket. If the recipient is offline, the message will be marked as failed.",
      operationId: "holos.send",
      responses: {
        200: {
          description: "Send result",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    messageId: z.string(),
                    sent: z.boolean(),
                    reason: z.string().optional(),
                  })
                  .meta({ ref: "HolosSendResponse" }),
              ),
            },
          },
        },
        ...errors(503),
      },
    }),
    validator(
      "json",
      z.object({
        toId: z.string().min(1).describe("Recipient Holos agent ID"),
        text: z.string().min(1).describe("Message text"),
        replyToMessageId: z.string().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const result = await Mailbox.send({
        toId: body.toId,
        text: body.text,
        replyToMessageId: body.replyToMessageId,
      })
      return c.json({ messageId: result.id, sent: result.sent, reason: result.reason })
    },
  )

  .post(
    "/send/:messageId/retry",
    describeRoute({
      summary: "Retry sending a failed message",
      description: "Attempt to resend a previously failed outbox message.",
      operationId: "holos.send.retry",
      responses: {
        200: {
          description: "Retry result",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    messageId: z.string(),
                    sent: z.boolean(),
                    reason: z.string().optional(),
                  })
                  .meta({ ref: "HolosRetryResponse" }),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ messageId: z.string() })),
    async (c) => {
      const { messageId } = c.req.valid("param")
      try {
        const result = await Mailbox.retry(messageId)
        return c.json({ messageId: result.id, sent: result.sent, reason: result.reason })
      } catch {
        return c.json({ message: "Message not found" }, 404)
      }
    },
  )

  .get(
    "/inbox",
    describeRoute({
      summary: "List inbox messages",
      description: "List all received messages, sorted by timestamp descending.",
      operationId: "holos.inbox.list",
      responses: {
        200: {
          description: "Inbox messages",
          content: {
            "application/json": { schema: resolver(z.array(z.unknown()).meta({ ref: "MailboxMessageList" })) },
          },
        },
      },
    }),
    async (c) => {
      const messages = await Mailbox.list("inbox")
      return c.json(messages)
    },
  )

  .get(
    "/outbox",
    describeRoute({
      summary: "List outbox messages",
      description: "List all sent messages, sorted by timestamp descending.",
      operationId: "holos.outbox.list",
      responses: {
        200: {
          description: "Outbox messages",
          content: {
            "application/json": { schema: resolver(z.array(z.unknown()).meta({ ref: "MailboxMessageList" })) },
          },
        },
      },
    }),
    async (c) => {
      const messages = await Mailbox.list("outbox")
      return c.json(messages)
    },
  )

  .get(
    "/thread/:contactId",
    describeRoute({
      summary: "Get conversation thread",
      description: "Get all messages (inbound + outbound) with a specific contact.",
      operationId: "holos.thread.get",
      responses: {
        200: {
          description: "Thread messages",
          content: {
            "application/json": { schema: resolver(z.array(z.unknown()).meta({ ref: "MailboxMessageList" })) },
          },
        },
      },
    }),
    validator("param", z.object({ contactId: z.string() })),
    async (c) => {
      const { contactId } = c.req.valid("param")
      const messages = await Mailbox.getThread(contactId)
      return c.json(messages)
    },
  )

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return char
    }
  })
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId
}

function resultPage(input: {
  title: string
  message: string
  success: boolean
  targetOrigin: string
  agentId?: string
  error?: string
}): string {
  const payload = input.success
    ? { type: "holos-login-success", agentId: input.agentId }
    : { type: "holos-login-failed", error: input.error ?? input.message }
  const statusLabel = input.success ? "Connected" : "Needs attention"
  const liveMessage = input.success ? "Returning to Synergy..." : "Return to Synergy and try again."
  const detail = !input.success && input.error ? input.error : undefined
  const agentMeta =
    input.success && input.agentId ? `<p class="meta">Agent ${escapeHtml(shortAgentId(input.agentId))}</p>` : ""
  const detailBlock = detail
    ? `<details class="details"><summary>Connection details</summary><p>${escapeHtml(detail)}</p></details>`
    : ""

  return `<!DOCTYPE html>
<html lang="en" data-result="${input.success ? "success" : "error"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f7f7f5;
  --surface: #ffffff;
  --text: #111827;
  --muted: #5d6470;
  --subtle: #8a919c;
  --border: #e2e4e8;
  --control: #f4f5f6;
  --control-hover: #eaebee;
  --success: #16a34a;
  --danger: #dc2626;
  --shadow: rgba(15, 23, 42, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1011;
    --surface: #18191b;
    --text: #f5f6f7;
    --muted: #c1c6ce;
    --subtle: #878d96;
    --border: #2b2d31;
    --control: #222429;
    --control-hover: #2a2d33;
    --success: #4ade80;
    --danger: #f87171;
    --shadow: rgba(0, 0, 0, 0.28);
  }
}
* {
  box-sizing: border-box;
}
body {
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.card {
  width: min(100%, 440px);
  padding: 28px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 8px 12px var(--shadow);
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  margin-bottom: 18px;
  color: var(--muted);
  font-size: 0.875rem;
  font-weight: 500;
}
.mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--success);
}
[data-result="error"] .mark {
  background: var(--danger);
}
h1 {
  margin: 0;
  font-size: 1.375rem;
  line-height: 1.2;
  letter-spacing: 0;
}
.message {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 0.96875rem;
  line-height: 1.55;
}
.meta {
  margin: 16px 0 0;
  color: var(--subtle);
  font-size: 0.875rem;
  line-height: 1.4;
}
.live {
  margin: 22px 0 0;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.875rem;
  line-height: 1.45;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 18px;
}
button,
a.button {
  min-height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--control);
  color: var(--text);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
}
button:hover,
a.button:hover {
  background: var(--control-hover);
}
button:focus-visible,
a.button:focus-visible,
summary:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.details {
  margin-top: 18px;
  color: var(--muted);
  font-size: 0.875rem;
}
summary {
  cursor: pointer;
  color: var(--text);
  font-weight: 500;
}
.details p {
  margin: 10px 0 0;
  color: var(--muted);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: no-preference) {
  .card {
    animation: enter 180ms ease-out;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
</style>
</head>
<body>
<main class="card" aria-labelledby="title">
  <div class="status"><span class="mark" aria-hidden="true"></span><span>${escapeHtml(statusLabel)}</span></div>
  <h1 id="title">${escapeHtml(input.title)}</h1>
  <p class="message">${escapeHtml(input.message)}</p>
  ${agentMeta}
  <p class="live" data-live aria-live="polite">${escapeHtml(liveMessage)}</p>
  <div class="actions">
    <button type="button" data-close>Close window</button>
    <a class="button" href="${escapeHtml(input.targetOrigin)}">Open Synergy</a>
  </div>
  ${detailBlock}
</main>
<script>
(() => {
  const payload = ${jsonForScript(payload)};
  const targetOrigin = ${jsonForScript(input.targetOrigin)};
  const shouldClose = ${input.success ? "true" : "false"};
  const live = document.querySelector("[data-live]");
  const closeButton = document.querySelector("[data-close]");
  closeButton?.addEventListener("click", () => window.close());

  let notified = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, targetOrigin);
      window.opener.focus?.();
      notified = true;
    }
  } catch {
    notified = false;
  }

  if (shouldClose && notified) {
    if (live) live.textContent = "Synergy was notified. Closing this window...";
    window.setTimeout(() => window.close(), 350);
    window.setTimeout(() => {
      if (live) live.textContent = "You can close this window and return to Synergy.";
    }, 1400);
  } else if (live) {
    live.textContent = notified ? "Synergy was notified. Return to the app to continue." : "Return to Synergy to continue.";
  }
})();
</script>
</body>
</html>`
}
