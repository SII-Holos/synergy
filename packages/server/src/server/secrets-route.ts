import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { errors } from "./error"

const SecretSource = z
  .object({
    kind: z.enum(["user", "config", "reference", "heuristic"]),
  })
  .partial()
  .optional()

const SecretPolicy = z
  .object({
    tools: z.array(z.string()).optional(),
    maxResolvesPerSession: z.number().int().positive().optional(),
  })
  .meta({ ref: "SecretPolicy" })

const SecretEntry = z
  .object({
    id: z.string(),
    fingerprint: z.object({ sha256: z.string(), length: z.number() }),
    source: z.any(),
    policy: SecretPolicy.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastResolvedAt: z.number().optional(),
    resolvedCount: z.number(),
  })
  .meta({ ref: "SecretEntry" })

const SecretCreateInput = z
  .object({
    value: z.string().min(1),
    policy: SecretPolicy.optional(),
  })
  .meta({ ref: "SecretCreateInput" })

const SecretRotateInput = z
  .object({
    value: z.string().min(1),
  })
  .meta({ ref: "SecretRotateInput" })

const SecretPolicyInput = z
  .object({
    policy: SecretPolicy,
  })
  .meta({ ref: "SecretPolicyInput" })

const ResolveAuditEntry = z
  .object({
    at: z.number(),
    sessionID: z.string().optional(),
    tool: z.string().optional(),
    outcome: z.enum(["resolved", "denied_policy", "denied_limit", "removed"]),
  })
  .meta({ ref: "SecretResolveAuditEntry" })

/**
 * No reveal route: plaintext secrets never cross the unauthenticated HTTP
 * surface (same posture as `config export --include-secrets` being CLI-only,
 * because loopback-wide CORS would let any local page read them). Rotation
 * and creation write values over HTTP, matching the existing config PATCH
 * contract that already accepts new secret values.
 */
export const SecretsRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List secret vault entries",
      description: "List registered secret vault entries. Values are never returned.",
      operationId: "secrets.list",
      responses: {
        200: {
          description: "Secret entries without values",
          content: { "application/json": { schema: resolver(z.array(SecretEntry)) } },
        },
      },
    }),
    async (c) => c.json(await SecretVault.list()),
  )
  .post(
    "/",
    describeRoute({
      summary: "Register a secret",
      description: "Register a value in the secret vault. Idempotent for an already-registered value.",
      operationId: "secrets.create",
      responses: {
        200: {
          description: "The registered entry without its value",
          content: { "application/json": { schema: resolver(SecretEntry) } },
        },
        ...errors(400),
      },
    }),
    validator("json", SecretCreateInput),
    async (c) => {
      const { value, policy } = c.req.valid("json")
      const entry = await SecretVault.register(value, { kind: "user" }, { policy })
      const { value: _stored, ...rest } = entry
      return c.json(rest)
    },
  )
  .patch(
    "/:id",
    describeRoute({
      summary: "Update a secret's policy",
      description: "Replace the per-key resolution policy of one vault entry.",
      operationId: "secrets.updatePolicy",
      responses: {
        200: {
          description: "The updated entry without its value",
          content: { "application/json": { schema: resolver(SecretEntry) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("json", SecretPolicyInput),
    async (c) => {
      const updated = await SecretVault.updatePolicy(c.req.param("id"), c.req.valid("json").policy)
      if (!updated) throw new Storage.NotFoundError({ message: `secret ${c.req.param("id")} does not exist` })
      return c.json(updated)
    },
  )
  .post(
    "/:id/rotate",
    describeRoute({
      summary: "Rotate a secret's value",
      description: "Replace the value of one vault entry; policy and resolve history carry over.",
      operationId: "secrets.rotate",
      responses: {
        200: {
          description: "The rotated entry without its value",
          content: { "application/json": { schema: resolver(SecretEntry) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("json", SecretRotateInput),
    async (c) => {
      const { value } = c.req.valid("json")
      try {
        const entry = await SecretVault.rotate(c.req.param("id"), value)
        const { value: _stored, ...rest } = entry
        return c.json(rest)
      } catch {
        throw new Storage.NotFoundError({ message: `secret ${c.req.param("id")} does not exist` })
      }
    },
  )
  .delete(
    "/:id",
    describeRoute({
      summary: "Remove a secret",
      description:
        "Remove one vault entry. Historical mask tokens stop resolving and render as revoked; re-registering the same value restores them.",
      operationId: "secrets.remove",
      responses: {
        200: {
          description: "Whether an entry was removed",
          content: { "application/json": { schema: resolver(z.object({ removed: z.boolean() })) } },
        },
      },
    }),
    async (c) => c.json({ removed: await SecretVault.remove(c.req.param("id")) }),
  )
  .get(
    "/:id/history",
    describeRoute({
      summary: "Read a secret's resolve history",
      description: "Read the bounded resolve audit trail of one vault entry.",
      operationId: "secrets.history",
      responses: {
        200: {
          description: "Resolve audit entries",
          content: { "application/json": { schema: resolver(z.array(ResolveAuditEntry)) } },
        },
      },
    }),
    async (c) => c.json(await SecretVault.resolveHistory(c.req.param("id"))),
  )

export type { SecretSource }
