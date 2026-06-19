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
import { Log } from "../util/log"
import { errors } from "./error"

const log = Log.create({ service: "server.holos" })

const pendingStates = new Map<string, { state: string; createdAt: number; callbackOrigin: string }>()

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
      z
        .object({
          callbackUrl: z.string().url().optional(),
        })
        .optional(),
    ),
    async (c) => {
      cleanupExpiredStates()
      const body = c.req.valid("json")
      const serverOrigin = new URL(c.req.url).origin
      const callbackUrl = resolveCallbackUrl({ requested: body?.callbackUrl, serverOrigin })
      if (!callbackUrl) return c.json({ message: "callbackUrl must point to this server's /holos/callback" }, 400)

      const state = crypto.randomUUID()
      pendingStates.set(state, { state, createdAt: Date.now(), callbackOrigin: new URL(callbackUrl).origin })

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
        return c.html(resultPage("Login Failed", "Missing code or state parameter.", false, callbackOrigin))
      }

      const pending = pendingStates.get(state)
      if (!pending) {
        return c.html(resultPage("Login Failed", "Invalid or expired state. Please try again.", false, callbackOrigin))
      }
      pendingStates.delete(state)

      try {
        const { agentId, agentSecret } = await HolosLoginFlow.exchange({ code, state })
        await HolosLoginFlow.saveAndReload({ agentId, agentSecret })
        return c.html(
          resultPage("Login Successful", "You can close this window.", true, pending.callbackOrigin, { agentId }),
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.html(resultPage("Login Failed", message, false, pending.callbackOrigin))
      }
    },
  )
  .post(
    "/credentials",
    describeRoute({
      summary: "Set agent credentials",
      description:
        "Validate and save existing agent credentials. Validates by fetching a ws_token, then saves and reloads the Holos runtime.",
      operationId: "holos.credentials",
      responses: {
        200: {
          description: "Credentials saved",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) }).meta({ ref: "HolosCredentialsResponse" })),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        agentId: z.string().min(1),
        agentSecret: z.string().min(1),
      }),
    ),
    async (c) => {
      const { agentId, agentSecret } = c.req.valid("json")

      const result = await HolosAuth.verifyCredentials(agentSecret)
      if (!result.valid) {
        return c.json({ message: result.reason }, 400)
      }

      await HolosAuth.saveCredentialsAndConfigure(agentId, agentSecret)
      HolosAuth.reloadRuntime().catch((err: unknown) =>
        log.warn("holos runtime reload after credentials save failed", { error: err }),
      )

      return c.json({ success: true as const })
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
          label: a.label,
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

function resultPage(
  title: string,
  message: string,
  success: boolean,
  targetOrigin: string,
  data?: { agentId: string },
): string {
  const postMessageScript =
    success && data
      ? `<script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'holos-login-success',
            agentId: ${JSON.stringify(data.agentId)}
          }, ${JSON.stringify(targetOrigin)});
        }
      </script>`
      : success
        ? ""
        : `<script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'holos-login-failed',
            error: ${JSON.stringify(message)}
          }, ${JSON.stringify(targetOrigin)});
        }
      </script>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333;max-width:400px}
h2{margin:0 0 1rem;color:${success ? "#4ade80" : "#f87171"}}p{margin:0;color:#999}</style>
</head><body><div class="card"><h2>${title}</h2><p>${message}</p></div>${postMessageScript}</body></html>`
}
