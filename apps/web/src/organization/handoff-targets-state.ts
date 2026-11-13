import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"

const scope = ["sessionID", "sourceRuntimeID", "bindingEpoch", "controlRevision", "shareGeneration"] as const

export function organizationHandoffTargetsPage(
  owner: {
    sessionID: string
    sourceRuntimeID: string
    bindingEpoch: number
    previous?: Handoff.TargetPage
  },
  value: unknown,
) {
  const page = Handoff.TargetPage.parse(value)
  const previous = owner.previous
  if (
    page.sessionID !== owner.sessionID ||
    page.sourceRuntimeID !== owner.sourceRuntimeID ||
    page.bindingEpoch !== owner.bindingEpoch ||
    (previous && scope.some((field) => page[field] !== previous[field])) ||
    page.items.some((target) => target.runtimeID === owner.sourceRuntimeID) ||
    new Set(page.items.map((target) => target.runtimeID)).size !== page.items.length
  )
    throw { code: "STALE_BINDING" }
  return page
}

export function organizationHandoffTargetReady(target: Handoff.Target) {
  return target.state === "active" && target.availability === "ready"
}
