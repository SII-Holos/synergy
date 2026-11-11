import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSessionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRuntimeError } from "./error"

function absent(): never {
  throw new OrganizationRuntimeError({
    code: "NOT_FOUND",
    message: "Native source Session is outside the authorized tree",
    outcome: "not_dispatched",
    retryable: false,
  })
}
async function retained(sessionID: string) {
  try {
    return await Session.get(sessionID)
  } catch (error) {
    if (error instanceof Storage.NotFoundError) return
    throw error
  }
}
export async function boundSessionSource(root: Session.Info, sourceSessionID = root.id) {
  const binding = Protocol.Binding.parse(root.organization)
  const source = sourceSessionID === root.id ? root : await retained(sourceSessionID)
  if (!source) return absent()
  let current = source
  const visited = new Set<string>()
  for (;;) {
    const observed = Protocol.Binding.safeParse(current.organization)
    if (
      visited.has(current.id) ||
      !observed.success ||
      current.scope.id !== binding.projectID ||
      JSON.stringify(observed.data) !== JSON.stringify(binding)
    )
      return absent()
    visited.add(current.id)
    if (current.id === root.id) return source
    if (!current.parentID || !current.cortex || current.cortex.parentSessionID !== current.parentID) return absent()
    const parent = await retained(current.parentID)
    if (!parent) return absent()
    current = parent
  }
}
