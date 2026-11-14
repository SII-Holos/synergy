import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { OrganizationSessionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { registerSyncMigrations } from "./sync-migration"
import { registerNativeSyncSource } from "./sync-native-source"
import { OrganizationSessionAdoption } from "./session-adoption"

export const SessionBindingError = NamedError.create(
  "OrganizationSessionBindingError",
  z.strictObject({ message: z.string() }),
)
const fields = { organization: Protocol.Binding.optional() }
type SessionShape = typeof fields
declare module "@ericsanchezok/synergy-harness/session/types" {
  interface SessionExtensionShape extends SessionShape {}
  interface SessionCreationExtensions {
    organization?: Protocol.Binding
  }
}

export function registerSessionSchema(member?: { orgID: string }) {
  registerSyncMigrations()
  if (member) registerNativeSyncSource(member.orgID)
  SessionSchemaRegistry.register("organization-runtime", {
    shape: fields,
    transferOwner: "organization-runtime",
    inherit: ["organization"],
    notificationReference(info) {
      const binding = fields.organization.parse(info.organization)
      return binding ? { version: 1, fields: { ...binding } } : undefined
    },
    async adoptTransfer(input) {
      if (input.source.organization === undefined && input.previous?.organization === undefined && !member) return {}
      return { organization: await OrganizationSessionAdoption.binding(input) }
    },
    async validateTransfer(input) {
      if (input.next.organization === undefined && input.previous?.organization === undefined && !member) return
      const expected = await OrganizationSessionAdoption.binding(input)
      if (JSON.stringify(fields.organization.parse(input.next.organization)) !== JSON.stringify(expected))
        throw new SessionBindingError({ message: "Session transfer changed its authorized organization binding" })
    },
    validateMutation({ previous, next, parent }) {
      const binding = fields.organization.parse(next.organization)
      if (previous && JSON.stringify(fields.organization.parse(previous.organization)) !== JSON.stringify(binding))
        throw new SessionBindingError({ message: "Session organization binding is immutable" })
      if (parent && JSON.stringify(fields.organization.parse(parent.organization)) !== JSON.stringify(binding))
        throw new SessionBindingError({ message: "Child Session must retain its parent's organization binding" })
      if (!binding) {
        if (member && !previous)
          throw new SessionBindingError({ message: "Member Session creation requires trusted organization binding" })
        return
      }
      if (previous && (previous.id !== next.id || previous.parentID !== next.parentID))
        throw new SessionBindingError({ message: "Session identity and parent ownership are immutable" })
      const scope = z.object({ type: z.literal("project"), id: z.literal(binding.projectID) }).safeParse(next.scope)
      if (!scope.success || (member && member.orgID !== binding.orgID))
        throw new SessionBindingError({ message: "Session binding does not match its organization and project Scope" })
    },
    normalizeImport(input) {
      if (member || input.organization !== undefined)
        throw new SessionBindingError({ message: "Organization Session import requires trusted admission" })
    },
  })
}
