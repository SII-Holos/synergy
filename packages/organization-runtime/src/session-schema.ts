import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { OrganizationSessionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"

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
  SessionSchemaRegistry.register("organization-runtime", {
    shape: fields,
    inherit: ["organization"],
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
