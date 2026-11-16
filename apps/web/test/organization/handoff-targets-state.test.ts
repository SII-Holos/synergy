import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import {
  organizationHandoffTargetsPage,
  organizationHandoffTargetReady,
} from "../../src/organization/handoff-targets-state"

const owner = { sessionID: "session", sourceRuntimeID: "source", bindingEpoch: 7 }
const page = Handoff.TargetPage.parse({
  ...owner,
  controlRevision: 11,
  shareGeneration: 2,
  items: [],
  cursor: "next-page",
})
const target = Handoff.Target.parse({
  runtimeID: "peer-computer",
  runtimeKind: "member",
  accountID: "another-member",
  displayName: "Another member",
  deviceID: "Peer-computer",
  state: "active",
  availability: "ready",
})

test("scoped destination pages retain empty cursors and do not need private Runtime registrations", () => {
  expect(organizationHandoffTargetsPage(owner, page)).toEqual(page)
  const next = organizationHandoffTargetsPage(
    { ...owner, previous: page },
    { ...page, items: [target], cursor: undefined },
  )
  expect(next.items).toEqual([target])
  expect(next.cursor).toBeUndefined()
  expect(organizationHandoffTargetReady(target)).toBe(true)
  for (const changed of [
    { state: "pending" },
    { state: "revoked" },
    { availability: "offline" },
    { availability: "incompatible" },
  ])
    expect(organizationHandoffTargetReady(Handoff.Target.parse({ ...target, ...changed }))).toBe(false)
})

test("a destination page cannot replace a different Session binding or scoped directory generation", () => {
  for (const changed of [
    { sessionID: "another-session" },
    { sourceRuntimeID: "another-source" },
    { bindingEpoch: 8 },
    { controlRevision: 12 },
    { shareGeneration: 3 },
    { items: [{ ...target, runtimeID: owner.sourceRuntimeID }] },
    { items: [target, target] },
  ])
    expect(() => organizationHandoffTargetsPage({ ...owner, previous: page }, { ...page, ...changed })).toThrow()
})
