import type { OrganizationInteractionProtocol as Interaction } from "@ericsanchezok/synergy-organization-protocol"

export const organizationInteractionKey = (row: Pick<Interaction.Pending, "kind" | "requestID">) =>
  `${row.kind}:${row.requestID}`
export function organizationInteractionWindow(input: {
  current: readonly Interaction.Pending[]
  incoming: readonly Interaction.Pending[]
  mode: "first" | "more" | "poll"
  selected?: Interaction.Pending
}): Interaction.Pending[] {
  const updates = new Map(input.incoming.map((row) => [organizationInteractionKey(row), row]))
  const entries =
    input.mode === "more"
      ? [...input.current, ...input.incoming]
      : input.mode === "first"
        ? [...input.incoming]
        : input.current.map((row) => updates.get(organizationInteractionKey(row)) ?? row)
  const candidates = [...new Map(entries.map((row) => [organizationInteractionKey(row), row])).values()]
  const window = input.mode === "more" ? candidates.slice(-128) : candidates.slice(0, 128)
  if (
    input.selected &&
    !window.some((row) => organizationInteractionKey(row) === organizationInteractionKey(input.selected!))
  ) {
    if (window.length >= 128) window.shift()
    window.unshift(input.selected)
  }
  return window
}
