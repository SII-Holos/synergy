import { z } from "zod"
import { OrganizationClientAuth as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { InfrastructureConfiguration } from "./infrastructure-schema"

export const ORGANIZATION_CONFIG_FILENAME = "150-organization.jsonc"

export const AuthenticationSettings = z.strictObject({
  bootstrapMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  inviteMs: z
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60_000),
  resetMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  loginMs: z
    .number()
    .int()
    .positive()
    .max(30 * 24 * 60 * 60_000)
    .default(30 * 24 * 60 * 60_000),
  hashConcurrency: z.number().int().min(1).max(16).default(2),
})
export type AuthenticationSettings = z.input<typeof AuthenticationSettings>

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

export const RuntimeRegistrationSettings = z.strictObject({
  ticketMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
})
export type RuntimeRegistrationSettings = z.input<typeof RuntimeRegistrationSettings>

export const RuntimeConnectionSettings = z
  .strictObject({
    authenticateMs: z.number().int().positive().default(5_000),
    heartbeatMs: z.number().int().positive().default(10_000),
    offlineMs: z.number().int().positive().default(30_000),
    proofAgeMs: z.number().int().positive().default(30_000),
  })
  .refine((value) => value.offlineMs > value.heartbeatMs, "The offline interval must exceed the heartbeat interval")
export type RuntimeConnectionSettings = z.input<typeof RuntimeConnectionSettings>

export const OrganizationSettings = z.strictObject({
  infrastructure: InfrastructureConfiguration.optional(),
  authentication: AuthenticationSettings.optional(),
  clientAuthentication: ClientAuthenticationSettings.optional(),
  registration: RuntimeRegistrationSettings.optional(),
  connections: RuntimeConnectionSettings.optional(),
})

export const ConfigShape = {
  organization: OrganizationSettings.optional().describe(
    "Dedicated organization service authentication, registered clients, machine connections and explicit infrastructure; restart after changes.",
  ),
}
export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
type ConfigShapeType = typeof ConfigShape
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
const contribution: ConfigExtensions.Contribution = { shape: ConfigShape }
export function registerConfig() {
  ConfigExtensions.register("organization", contribution)
  ConfigDomain.register({
    id: "organization",
    filename: ORGANIZATION_CONFIG_FILENAME,
    label: "Organization service",
    ownedKeys: ["organization"],
    mergePolicy: "replace-domain",
    reloadTargets: [],
    uiSection: "organization",
    importable: true,
    globalOnly: true,
    failClosed: true,
  })
}
