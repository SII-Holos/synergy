import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { OrganizationClientAuth as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { z } from "zod"
import { digest } from "./secret"
import { fail } from "../error"

export const ClientAuthenticationSettings = z.strictObject({
  clients: z
    .array(Protocol.Client)
    .default([])
    .refine(
      (clients) => new Set(clients.map((client) => client.clientID)).size === clients.length,
      "Client IDs must be unique",
    ),
  codeMs: z.number().int().positive().max(60_000).default(60_000),
  accessMs: z
    .number()
    .int()
    .positive()
    .max(15 * 60_000)
    .default(15 * 60_000),
  refreshMs: z
    .number()
    .int()
    .positive()
    .max(30 * 24 * 60 * 60_000)
    .default(30 * 24 * 60 * 60_000),
})
export type ClientAuthenticationSettings = z.input<typeof ClientAuthenticationSettings>

export namespace ClientPolicy {
  const state = RuntimeContext.state(() => ({
    issuer: undefined as string | undefined,
    clients: new Map<string, Protocol.Client>(),
  }))
  export function configure(issuer: string | undefined, clients: Protocol.Client[]) {
    if (clients.length && !issuer) throw new Error("Client authentication requires an organization public origin")
    state().issuer = issuer
    state().clients = new Map(clients.map((client) => [client.clientID, structuredClone(client)]))
  }
  export function issuer() {
    const value = state().issuer
    if (!value) fail("SERVICE_UNAVAILABLE", "The organization public origin is not configured")
    return value
  }
  export function client(id: string) {
    const value = state().clients.get(id)
    if (!value) fail("AUTHENTICATION_REQUIRED", "The organization client is unavailable")
    return value
  }
  export function fingerprint(value: Protocol.Client) {
    return digest(JSON.stringify([issuer(), value]))
  }
  export function allowsOrigin(origin: string) {
    return (
      origin === state().issuer ||
      [...state().clients.values()].some(
        (client) => client.kind === "web" && new URL(client.redirectUri).origin === origin,
      )
    )
  }
  export function checkOrigin(client: Protocol.Client, origin?: string) {
    if (origin && (client.kind !== "web" || new URL(client.redirectUri).origin !== origin))
      fail("PERMISSION_DENIED", "The request origin is not allowed")
  }
}
