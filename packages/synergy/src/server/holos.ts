import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Access } from "../access"
import { Contact } from "../holos/contact"
import { FriendReply } from "../holos/friend-reply"
import { FriendRequest } from "../holos/friend-request"
import { HolosMessageMetadata } from "../holos/message-metadata"
import { HolosAuth } from "../holos/auth"
import { HOLOS_URL } from "../holos/constants"
import { HolosLoginFlow } from "../holos/login-flow"
import { HolosProfile } from "../holos/profile"
import { HolosProtocol } from "../holos/protocol"
import { HolosReadiness } from "../holos/readiness"
import { HolosRequest } from "../holos/request"
import { MessageQueue } from "../holos/queue"
import { Presence } from "../holos/presence"
import { HolosRuntime } from "../holos/runtime"
import { HolosState } from "../holos/state"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { errors } from "./error"
import { Scope } from "../scope"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { SessionEndpoint } from "../session/endpoint"

const log = Log.create({ service: "server.holos" })

const pendingStates = new Map<string, { state: string; createdAt: number }>()

const STATE_TTL_MS = 5 * 60_000

function holosApiUrl(path: string): string {
  return new URL(path, HOLOS_URL).toString()
}

async function resolvePrimaryHolosConnection() {
  const provider = await HolosRuntime.getProvider()
  if (!provider) return null
  return { provider }
}

function cleanupExpiredStates() {
  const now = Date.now()
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(key)
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

      const state = crypto.randomUUID()
      pendingStates.set(state, { state, createdAt: Date.now() })

      const body = c.req.valid("json")
      const callbackUrl = body?.callbackUrl ?? Access.fromServerUrl(new URL(c.req.url).origin).callbackUrl

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

      if (!code || !state) {
        return c.html(resultPage("Login Failed", "Missing code or state parameter.", false))
      }

      const pending = pendingStates.get(state)
      if (!pending) {
        return c.html(resultPage("Login Failed", "Invalid or expired state. Please try again.", false))
      }
      pendingStates.delete(state)

      try {
        const { agentId, agentSecret } = await HolosLoginFlow.exchange({ code, state })
        await HolosLoginFlow.saveAndReload({ agentId, agentSecret })
        return c.html(resultPage("Login Successful", "You can close this window.", true, { agentId }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.html(resultPage("Login Failed", message, false))
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
      summary: "Disconnect Holos channel",
      description: "Disconnect the Holos channel without removing stored Holos credentials.",
      operationId: "holos.disconnect",
      responses: {
        200: {
          description: "Holos channel disconnected",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.literal(true) }).meta({ ref: "HolosDisconnectResponse" })),
            },
          },
        },
      },
    }),
    async (c) => {
      const { Channel } = await import("../channel")
      const statuses = await Channel.status()
      for (const key of Object.keys(statuses)) {
        if (key.startsWith("holos:")) {
          const [channelType, accountId] = key.split(":")
          await Channel.disconnect(channelType, accountId).catch(() => {})
        }
      }
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

  // --- Profile ---

  .get(
    "/profile",
    describeRoute({
      summary: "Get profile",
      description: "Retrieve the current agent profile.",
      operationId: "holos.profile.get",
      responses: {
        200: {
          description: "Agent profile",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    agentId: z.string().nullable(),
                    profile: HolosProfile.Info.nullable(),
                  })
                  .meta({ ref: "HolosProfileResponse" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const [profile, credentials] = await Promise.all([HolosProfile.get(), HolosAuth.getStoredCredential()])
      return c.json({ agentId: credentials?.agentId ?? null, profile: profile ?? null })
    },
  )

  .put(
    "/profile",
    describeRoute({
      summary: "Update profile",
      description: "Update the current agent profile.",
      operationId: "holos.profile.update",
      responses: {
        200: {
          description: "Updated profile",
          content: { "application/json": { schema: resolver(HolosProfile.Info) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        name: z.string(),
        bio: z.string(),
      }),
    ),

    async (c) => {
      const body = c.req.valid("json")
      const existing = await HolosProfile.get()
      const profile = await HolosProfile.update({
        name: body.name,
        bio: body.bio,
        initialized: true,
        initializedAt: existing?.initializedAt ?? Date.now(),
      })

      return c.json(profile)
    },
  )

  .post(
    "/profile/reset",
    describeRoute({
      summary: "Reset profile initialization",
      description: "Set the profile initialized flag to false, allowing the user to re-run the onboarding setup flow.",
      operationId: "holos.profile.reset",
      responses: {
        200: {
          description: "Profile reset",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
      },
    }),
    async (c) => {
      const existing = await HolosProfile.get()
      if (existing) {
        await HolosProfile.update({ ...existing, initialized: false })
      }
      return c.json(true)
    },
  )

  .post(
    "/profile/skip-genesis",
    describeRoute({
      summary: "Skip genesis and create default profile",
      description: "Creates a default profile, skipping the onboarding chat. No-ops if profile is already initialized.",
      operationId: "holos.profile.skipGenesis",
      responses: {
        200: {
          description: "Profile",
          content: { "application/json": { schema: resolver(HolosProfile.Info) } },
        },
      },
    }),
    async (c) => {
      const existing = await HolosProfile.get()
      if (existing?.initialized) return c.json(existing)
      const profile = await HolosProfile.update(HolosProfile.defaultProfile())
      return c.json(profile)
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
        holosId: z.string().optional(),
        name: z.string(),
        bio: z.string().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const contact = await Contact.add({
        id: body.id,
        holosId: body.holosId,
        name: body.name,
        bio: body.bio,
        status: "active",
        addedAt: Date.now(),
        config: { autoReply: false, autoInitiate: false, blocked: false, maxAutoTurns: 10 },
      })
      return c.json(contact)
    },
  )

  // --- Friend Requests ---

  .get(
    "/friend-request",
    describeRoute({
      summary: "List friend requests",
      description: "List all friend requests.",
      operationId: "holos.friendRequest.list",
      responses: {
        200: {
          description: "List of friend requests",
          content: { "application/json": { schema: resolver(FriendRequest.Info.array()) } },
        },
      },
    }),
    async (c) => {
      const requests = await FriendRequest.list()
      return c.json(requests)
    },
  )

  .post(
    "/friend-request",
    describeRoute({
      summary: "Create friend request",
      description: "Create a new outgoing friend request.",
      operationId: "holos.friendRequest.create",
      responses: {
        200: {
          description: "Created friend request",
          content: { "application/json": { schema: resolver(FriendRequest.Info) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        id: z.string(),
        peerId: z.string(),
        peerName: z.string().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const request = await FriendRequest.create({
        id: body.id,
        direction: "outgoing",
        peerId: body.peerId,
        peerName: body.peerName,
        status: "pending",
        createdAt: Date.now(),
      })
      return c.json(request)
    },
  )

  .delete(
    "/friend-request/:id",
    describeRoute({
      summary: "Remove friend request",
      description: "Remove a friend request.",
      operationId: "holos.friendRequest.remove",
      responses: {
        200: {
          description: "Removed",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
      },
    }),
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      await FriendRequest.remove(c.req.valid("param").id)
      return c.json(true)
    },
  )

  // --- Friend request actions (bridge to provider) ---

  .post(
    "/friend-request/send",
    describeRoute({
      summary: "Send friend request",
      description: "Send an outgoing friend request to another agent via WebSocket.",
      operationId: "holos.friendRequest.send",
      responses: {
        200: {
          description: "Friend request sent or queued",
          content: {
            "application/json": {
              schema: resolver(z.object({ queued: z.boolean() }).meta({ ref: "FriendRequestSendResponse" })),
            },
          },
        },
        ...errors(400, 503),
      },
    }),
    validator(
      "json",
      z.object({ peerId: z.string(), peerName: z.string().optional(), peerBio: z.string().optional() }),
    ),
    async (c) => {
      const connection = await resolvePrimaryHolosConnection()
      if (!connection) return c.json({ message: "Holos not connected" }, 503)

      const body = c.req.valid("json")
      const result = await connection.provider.sendFriendRequest(body.peerId, body.peerName, body.peerBio)
      return c.json({ queued: result.queued })
    },
  )

  .put(
    "/friend-request/:id/respond",
    describeRoute({
      summary: "Respond to friend request",
      description: "Accept or reject a friend request. Sends the response over WebSocket and updates local storage.",
      operationId: "holos.friendRequest.respond",
      responses: {
        200: {
          description: "Updated friend request",
          content: { "application/json": { schema: resolver(FriendRequest.Info) } },
        },
        ...errors(400, 404, 503),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator("json", z.object({ status: z.enum(["accepted", "rejected"]) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")

        const request = await FriendRequest.get(id)
        if (!request) return c.json({ message: "Friend request not found" }, 404)

        const connection = await resolvePrimaryHolosConnection()
        if (connection) {
          if (body.status === "accepted") {
            await connection.provider.acceptFriendRequest(request.peerId)

            const existing = await Contact.get(request.peerId)
            if (!existing) {
              await Contact.add({
                id: request.peerId,
                holosId: request.peerId,
                name: request.peerName ?? "Unknown",
                bio: request.peerBio,
                status: "active",
                addedAt: Date.now(),
                config: { autoReply: false, autoInitiate: false, blocked: false, maxAutoTurns: 10 },
              })
            }
          } else {
            await connection.provider.rejectFriendRequest(request.peerId)
          }
        }

        const updated = await FriendRequest.respond(id, body.status)
        return c.json(updated)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ message }, 400)
      }
    },
  )

  .delete(
    "/contact/:id",
    describeRoute({
      summary: "Remove contact",
      description: "Remove a contact and notify the peer via WebSocket.",
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

      if (contact?.holosId) {
        const connection = await resolvePrimaryHolosConnection()
        if (connection) {
          await connection.provider.removeFriend(contact.holosId).catch(() => {})
        }
        Presence.remove(contact.holosId)
        await Session.archiveEndpointSession(SessionEndpoint.holos(contact.holosId)).catch((err: unknown) =>
          log.warn("failed to archive session for removed contact", { id, error: err }),
        )
      }

      await Contact.remove(id)
      return c.json(true)
    },
  )

  // --- Contact config ---

  .put(
    "/contact/:id/config",
    describeRoute({
      summary: "Update contact config",
      description: "Update per-contact configuration (autoReply, autoInitiate, blocked).",
      operationId: "holos.contact.updateConfig",
      responses: {
        200: {
          description: "Updated contact",
          content: { "application/json": { schema: resolver(Contact.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator(
      "json",
      z.object({
        autoReply: z.boolean().optional(),
        autoInitiate: z.boolean().optional(),
        blocked: z.boolean().optional(),
        maxAutoTurns: z.number().optional(),
      }),
    ),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")
        const updated = await Contact.updateConfig(id, body)
        return c.json(updated)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ message }, 404)
      }
    },
  )

  // --- Contact session ---

  .get(
    "/contact/:id/session",
    describeRoute({
      summary: "Get or create session for contact",
      description: "Returns the friend session for a contact, creating one if it doesn't exist yet.",
      operationId: "holos.contact.session",
      responses: {
        200: {
          description: "Session info for navigation",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    sessionID: z.string(),
                    directory: z.string(),
                  })
                  .meta({ ref: "HolosContactSessionResponse" }),
              ),
            },
          },
        },
        ...errors(404, 503),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const contact = await Contact.get(id)
        if (!contact) return c.json({ message: "Contact not found" }, 404)

        const provider = await HolosRuntime.getProvider()
        if (!provider) return c.json({ message: "Holos not connected" }, 503)

        const session = await HolosRuntime.getOrCreateSession(contact.holosId ?? contact.id, Scope.global())

        const sessionScope = session.scope as { type?: string; directory?: string }
        return c.json({
          sessionID: session.id,
          directory: sessionScope.type === "global" ? "global" : (sessionScope.directory ?? "global"),
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ message }, 404)
      }
    },
  )

  // --- Send message ---

  .post(
    "/contact/:id/message",
    describeRoute({
      summary: "Send message to contact",
      description:
        "Send a message to a contact via the friend session mailbox. " +
        "The outbound hook handles Holos WS delivery automatically.",
      operationId: "holos.contact.sendMessage",
      responses: {
        200: {
          description: "Message delivered to session",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    sessionID: z.string(),
                  })
                  .meta({ ref: "HolosSendMessageResponse" }),
              ),
            },
          },
        },
        ...errors(400, 403, 404, 503),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator(
      "json",
      z.object({
        text: z.string().min(1),
        replyToMessageId: z.string().optional(),
      }),
    ),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")

        const contact = await Contact.get(id)
        if (!contact) return c.json({ message: "Contact not found" }, 404)
        if (contact.config.blocked) return c.json({ message: "Contact is blocked" }, 403)

        const provider = await HolosRuntime.getProvider()
        if (!provider) return c.json({ message: "Holos not connected" }, 503)

        const session = await HolosRuntime.getOrCreateSession(contact.holosId ?? contact.id, Scope.global())
        log.debug("[send-message] session resolved", { sessionID: session.id, contactId: id })

        const textPart: MessageV2.TextPart = {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: Identifier.ascending("message"),
          type: "text",
          text: body.text,
        }

        const replyToMessage = body.replyToMessageId
          ? (await Session.messages({ sessionID: session.id, limit: 200 })).find(
              (message) => message.info.id === body.replyToMessageId,
            )
          : undefined
        if (body.replyToMessageId && !replyToMessage) {
          return c.json({ message: "Reply target not found in this conversation" }, 400)
        }

        const quotedText = MessageV2.extractText(replyToMessage?.parts ?? [])
        const replyMetadata = (replyToMessage?.info.metadata as Record<string, unknown> | undefined) ?? undefined
        const replyToHolosMessageId = HolosMessageMetadata.holos(replyMetadata)?.messageId

        const mail: SessionManager.SessionMail.Assistant = {
          type: "assistant",
          parts: [textPart],
          metadata: HolosMessageMetadata.merge(undefined, {
            source: "human",
            holos: replyToHolosMessageId
              ? {
                  replyToMessageId: replyToHolosMessageId,
                }
              : undefined,
            quote: body.replyToMessageId
              ? {
                  messageId: body.replyToMessageId,
                  text: quotedText || undefined,
                  senderName: replyToMessage?.info.role === "user" ? contact.name : "You",
                }
              : undefined,
          }),
        }

        log.debug("[send-message] delivering assistant mail", { sessionID: session.id, messageID: textPart.messageID })
        await SessionManager.deliver({ target: session.id, mail })

        FriendReply.resetAutoTurnCount(contact.holosId ?? contact.id).catch((err: unknown) => {
          log.warn("failed to reset auto-turn count", { contactId: id, error: err })
        })

        return c.json({ sessionID: session.id })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ message }, 400)
      }
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
  .post(
    "/refresh-presence",
    describeRoute({
      summary: "Refresh friend presence",
      description: "Trigger a fresh presence probe for all unblocked Holos contacts.",
      operationId: "holos.refreshPresence",
      responses: {
        200: {
          description: "Presence refresh triggered",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    success: z.literal(true),
                    count: z.number(),
                  })
                  .meta({ ref: "HolosPresenceRefreshResponse" }),
              ),
            },
          },
        },
        ...errors(503),
      },
    }),
    async (c) => {
      const connection = await resolvePrimaryHolosConnection()
      if (!connection) return c.json({ message: "Holos not connected" }, 503)

      const result = await connection.provider.refreshPresence()
      return c.json({ success: true as const, count: result.count })
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

      const res = await HolosRequest.fetch(holosApiUrl(`/api/v1/holos/agent_tunnel/agents/list?${params}`), undefined, {
        capability: "agent_lookup",
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
      const res = await HolosRequest.fetch(holosApiUrl(`/api/v1/holos/agent_tunnel/agents/${agentId}`), undefined, {
        capability: "agent_lookup",
      })
      if (!res.ok) return c.json({ message: `Agent not found: ${res.status}` }, 404)

      const body = await res.json()
      return c.json(body)
    },
  )

  // --- Message queue ---

  .get(
    "/queue",
    describeRoute({
      summary: "List message queue",
      description: "List all pending messages in the outgoing message queue.",
      operationId: "holos.queue.list",
      responses: {
        200: {
          description: "Queue items",
          content: { "application/json": { schema: resolver(MessageQueue.Info.array()) } },
        },
      },
    }),
    async (c) => {
      const items = await MessageQueue.list()
      return c.json(items)
    },
  )

  // --- Friend reply sub-sessions ---

  .get(
    "/friend-reply/:sessionId",
    describeRoute({
      summary: "List friend reply sub-sessions",
      description: "List all sub-session mappings for a friend session. Maps trigger message IDs to sub-session IDs.",
      operationId: "holos.friendReply.list",
      responses: {
        200: {
          description: "Sub-session mappings",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .array(
                    z.object({
                      triggerMessageId: z.string(),
                      subSessionId: z.string(),
                    }),
                  )
                  .meta({ ref: "FriendReplyMapping" }),
              ),
            },
          },
        },
      },
    }),
    validator("param", z.object({ sessionId: z.string() })),
    async (c) => {
      const sessionId = c.req.valid("param").sessionId
      const mappings = await FriendReply.listSubSessions(sessionId)
      return c.json(mappings)
    },
  )

function resultPage(title: string, message: string, success: boolean, data?: { agentId: string }): string {
  const postMessageScript =
    success && data
      ? `<script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'holos-login-success',
            agentId: ${JSON.stringify(data.agentId)}
          }, '*');
        }
      </script>`
      : success
        ? ""
        : `<script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'holos-login-failed',
            error: ${JSON.stringify(message)}
          }, '*');
        }
      </script>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:1rem;background:#1a1a1a;border:1px solid #333;max-width:400px}
h2{margin:0 0 1rem;color:${success ? "#4ade80" : "#f87171"}}p{margin:0;color:#999}</style>
</head><body><div class="card"><h2>${title}</h2><p>${message}</p></div>${postMessageScript}</body></html>`
}
