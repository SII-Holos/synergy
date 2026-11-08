import { describe, expect, test } from "bun:test"
import { OrganizationProtocol } from "../src/index"

const member = {
  type: "handshake",
  protocolVersion: 1,
  orgID: "org-one",
  deploymentIncarnation: "deployment-one",
  runtimeID: "runtime-one",
  runtimeKind: "member",
  accountID: "account-one",
  deviceID: "device-one",
  buildVersion: "1.1.26",
  connectionEpoch: 1,
  capabilities: ["session.commands"],
  schemas: { session: 1 },
} satisfies OrganizationProtocol.Handshake

describe("organization bridge handshake", () => {
  test("accepts compatible release builds without equating build and protocol versions", () => {
    expect(OrganizationProtocol.Handshake.parse(member)).toEqual(member)
    expect(OrganizationProtocol.Handshake.parse({ ...member, buildVersion: "1.2.0" }).buildVersion).toBe("1.2.0")
    const { accountID: _accountID, deviceID: _deviceID, ...hosted } = member
    expect(OrganizationProtocol.Handshake.parse({ ...hosted, runtimeKind: "hosted" }).runtimeKind).toBe("hosted")
  })

  test("rejects unknown versions, fields, incomplete member identity and unsafe counters", () => {
    for (const value of [
      { ...member, protocolVersion: 2 },
      { ...member, bearer: "must-not-enter-protocol" },
      { ...member, accountID: undefined },
      { ...member, deviceID: undefined },
      { ...member, connectionEpoch: -1 },
      { ...member, connectionEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...member, runtimeKind: "hosted" },
    ])
      expect(OrganizationProtocol.Handshake.safeParse(value).success).toBe(false)
  })

  test("keeps private local Session registration limited to the agreed metadata", () => {
    const directory = {
      sessionID: "session-one",
      projectID: "project-one",
      creatorID: "account-one",
      driverRuntimeID: "runtime-one",
      bindingEpoch: 1,
      createdAt: 1,
      shareState: "private",
      resourceIDs: ["model-one"],
      executionGrantIDs: [],
    } satisfies OrganizationProtocol.PrivateSessionRegistration
    expect(OrganizationProtocol.PrivateSessionRegistration.parse(directory)).toEqual(directory)
    for (const extra of [{ title: "private" }, { messages: [] }, { localPath: "/private" }, { tools: [] }]) {
      expect(OrganizationProtocol.PrivateSessionRegistration.safeParse({ ...directory, ...extra }).success).toBe(false)
    }
  })
})
