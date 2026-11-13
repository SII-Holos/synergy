import { expect, test } from "bun:test"
import {
  OrganizationHandoffRecovery as Recovery,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { organizationOwnDevices, organizationDeviceCleanupPage } from "../../src/organization/account-devices-state"

const owner = { orgID: "org", deploymentIncarnation: "inc", accountID: "account" }
const runtime = Runtime.MemberRegistrationRecord.parse({
  ...owner,
  runtimeID: "self",
  runtimeKind: "member",
  deviceID: "This-computer",
  publicKey: "a".repeat(64),
  state: "active",
  revision: 1,
  connectionEpoch: 1,
  createdAt: 0,
})
const descriptor = Recovery.Descriptor.parse({
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "inc",
  handoffID: "old-move",
  sessionID: "private-session",
  sourceRuntimeID: "source",
  targetRuntimeID: "self",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 0,
  manifestHash: "b".repeat(64),
})

test("device pages preserve a finite cursor while excluding other members even for an administrator", () => {
  const foreign = { ...runtime, runtimeID: "foreign", accountID: "another-account" }
  expect(organizationOwnDevices(owner, { items: [foreign], cursor: "another-page" })).toEqual({
    items: [],
    cursor: "another-page",
  })
  expect(organizationOwnDevices(owner, { items: [foreign, runtime] }).items).toEqual([runtime])
  expect(() =>
    organizationOwnDevices(owner, { items: [{ ...runtime, deploymentIncarnation: "another-inc" }] }),
  ).toThrow("owner")
})

test("cleanup descriptors bind only the current active self Runtime and original deployment", () => {
  const page = organizationDeviceCleanupPage(owner, runtime, { items: [descriptor], cursor: "another-page" })
  expect(page.cursor).toBe("another-page")
  expect(page.items[0]?.handle).toMatchObject({
    manifestHash: descriptor.manifestHash,
    binding: { handoffID: "old-move", targetRuntimeID: "self" },
    runtime,
  })
  for (const changed of [
    { accountID: "another-account" },
    { state: "revoked" },
    { deploymentIncarnation: "another-inc" },
  ])
    expect(() =>
      organizationDeviceCleanupPage(owner, Runtime.MemberRegistrationRecord.parse({ ...runtime, ...changed }), {
        items: [descriptor],
      }),
    ).toThrow("owner")
  for (const changed of [
    { targetRuntimeID: "another-runtime" },
    { orgID: "another-org" },
    { deploymentIncarnation: "another-inc" },
  ])
    expect(() => organizationDeviceCleanupPage(owner, runtime, { items: [{ ...descriptor, ...changed }] })).toThrow(
      "owner",
    )
})
